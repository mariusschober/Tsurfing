import XCTest
@testable import GoalflowMac

private final class AuthURLProtocolStub: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        let current = Self.handler
        Self.lock.unlock()
        do {
            guard let current else { throw URLError(.unsupportedURL) }
            let (response, data) = try current(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

final class EmailOtpAuthTests: XCTestCase {
    private let userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private let sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    private let attemptToken = String(repeating: "A", count: 43)

    override func tearDown() {
        AuthURLProtocolStub.lock.lock()
        AuthURLProtocolStub.handler = nil
        AuthURLProtocolStub.lock.unlock()
        super.tearDown()
    }

    func test_typed_code_activates_before_keychain_session_becomes_usable() async throws {
        let store = makeStore()
        defer { clear(store) }
        let service = makeService(store: store)
        var paths: [String] = []

        setHandler { request in
            paths.append(request.url!.path)
            switch request.url!.path {
            case "/api/v1/auth/email/preflight":
                let body = try Self.jsonBody(request)
                XCTAssertEqual(body["email"] as? String, "person@example.invalid")
                XCTAssertEqual(body["purpose"] as? String, "activation")
                XCTAssertEqual(body["captchaToken"] as? String, "captcha-proof-token-12345")
                return self.response(request, status: 202, object: [
                    "accepted": true,
                    "attemptToken": self.attemptToken,
                    "expiresInSeconds": 600,
                    "resendAfterSeconds": 60
                ])
            case "/auth/v1/verify":
                let body = try Self.jsonBody(request)
                XCTAssertEqual(body["token"] as? String, "123456")
                XCTAssertEqual(body["type"] as? String, "email")
                return self.response(request, object: self.tokenResponse())
            case "/api/v1/auth/email/activate":
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(self.accessToken())")
                XCTAssertEqual(try Self.jsonBody(request)["attemptToken"] as? String, self.attemptToken)
                return self.response(request, object: ["activated": true])
            case "/api/v1/session":
                return self.response(request, object: [
                    "user": ["id": self.userId, "email": "person@example.invalid", "role": "beta", "status": "active"],
                    "assuranceLevel": "aal1"
                ])
            default:
                throw URLError(.unsupportedURL)
            }
        }

        let pending = try await service.requestEmailCode(
            email: " Person@Example.invalid ",
            purpose: .activation,
            inviteCode: "invite-code",
            captchaToken: "captcha-proof-token-12345"
        )
        XCTAssertEqual(pending.attemptToken, attemptToken)
        XCTAssertEqual(try store.readPendingEmailOtp(), pending)
        XCTAssertFalse(store.isAuthenticated)

        let profile = try await service.verifyEmailCode(email: pending.email, code: "123456")

        XCTAssertEqual(profile.userId, userId)
        XCTAssertEqual(profile.email, "person@example.invalid")
        XCTAssertNil(try store.readPendingEmailOtp())
        XCTAssertTrue(store.isAuthenticated)
        XCTAssertEqual(paths, [
            "/api/v1/auth/email/preflight",
            "/auth/v1/verify",
            "/api/v1/auth/email/activate",
            "/api/v1/session"
        ])
    }

    func test_lost_activation_ack_retries_without_reusing_email_code() async throws {
        let store = makeStore()
        defer { clear(store) }
        let service = makeService(store: store)
        var verifyCount = 0
        var activationCount = 0

        setHandler { request in
            switch request.url!.path {
            case "/api/v1/auth/email/preflight":
                return self.response(request, status: 202, object: [
                    "accepted": true,
                    "attemptToken": self.attemptToken,
                    "expiresInSeconds": 600,
                    "resendAfterSeconds": 60
                ])
            case "/auth/v1/verify":
                verifyCount += 1
                return self.response(request, object: self.tokenResponse())
            case "/api/v1/auth/email/activate":
                activationCount += 1
                return self.response(request, status: activationCount == 1 ? 503 : 200,
                                     object: activationCount == 1 ? ["error": "unavailable"] : ["activated": true])
            default:
                throw URLError(.unsupportedURL)
            }
        }

        _ = try await service.requestEmailCode(
            email: "person@example.invalid",
            purpose: .signIn,
            captchaToken: "captcha-proof-token-12345"
        )
        do {
            _ = try await service.verifyEmailCode(email: "person@example.invalid", code: "123456")
            XCTFail("Expected the first activation acknowledgement to fail")
        } catch AuthError.transient {}

        XCTAssertNotNil(try store.read())
        XCTAssertNotNil(try store.readPendingEmailOtp())
        XCTAssertFalse(store.isAuthenticated)
        let resumed = try await service.resumePendingEmailActivation()
        XCTAssertTrue(resumed)
        XCTAssertEqual(verifyCount, 1)
        XCTAssertEqual(activationCount, 2)
        XCTAssertNil(try store.readPendingEmailOtp())
        XCTAssertTrue(store.isAuthenticated)
    }

    func test_preexisting_session_never_bypasses_typed_email_code_verification() async throws {
        let store = makeStore()
        defer { clear(store) }
        let service = makeService(store: store)
        let existingData = try JSONSerialization.data(withJSONObject: tokenResponse(), options: [.sortedKeys])
        try store.save(parseNativeSessionResponse(
            existingData,
            configuration: MacCloudConfiguration(
                apiOrigin: "https://app.tsurfing.test",
                supabaseURL: "https://project.supabase.co",
                publishableKey: "sb_publishable_tsurfing_test_only_value"
            )
        ))
        try store.savePendingEmailOtp(PendingEmailOtpAttempt(
            attemptToken: attemptToken,
            email: "person@example.invalid",
            purpose: .activation,
            expiresAt: Date().addingTimeInterval(600),
            resendAt: Date().addingTimeInterval(60)
        ))
        var paths: [String] = []
        setHandler { request in
            paths.append(request.url!.path)
            switch request.url!.path {
            case "/auth/v1/verify":
                return self.response(request, object: self.tokenResponse())
            case "/api/v1/auth/email/activate":
                return self.response(request, object: ["activated": true])
            case "/api/v1/session":
                return self.response(request, object: [
                    "user": ["id": self.userId, "email": "person@example.invalid", "role": "beta", "status": "active"],
                    "assuranceLevel": "aal1"
                ])
            default:
                throw URLError(.unsupportedURL)
            }
        }

        _ = try await service.verifyEmailCode(email: "person@example.invalid", code: "123456")

        XCTAssertEqual(paths, ["/auth/v1/verify", "/api/v1/auth/email/activate", "/api/v1/session"])
    }

    func test_telegram_sign_in_uses_supabase_pkce_without_legacy_widget_parameters() throws {
        let store = makeStore()
        defer { clear(store) }
        let service = makeService(store: store, telegramEnabled: true)

        let authorizationURL = try service.beginTelegramSignIn()
        let components = try XCTUnwrap(URLComponents(url: authorizationURL, resolvingAgainstBaseURL: false))
        let items = try XCTUnwrap(components.queryItems)
        let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        let pending = try XCTUnwrap(store.readPendingRequest())

        XCTAssertEqual(components.path, "/auth/v1/authorize")
        XCTAssertEqual(Set(values.keys), Set(["provider", "redirect_to", "scopes", "code_challenge", "code_challenge_method"]))
        XCTAssertEqual(values["provider"], "custom:telegram")
        XCTAssertEqual(values["scopes"], "openid profile telegram:bot_access")
        XCTAssertNil(values["origin"])
        XCTAssertNil(values["bot_id"])
        XCTAssertEqual(values["code_challenge_method"], "s256")
        XCTAssertEqual(values["code_challenge"], pkceChallenge(pending.verifier))
        XCTAssertEqual(pending.flow, .telegramSignIn)
        XCTAssertEqual(values["redirect_to"], pending.redirectURL)
        XCTAssertNil(values["state"])
        XCTAssertNil(values["id"])
        XCTAssertNil(values["auth_date"])
        XCTAssertNil(values["hash"])

        let redirect = try XCTUnwrap(URLComponents(string: pending.redirectURL))
        XCTAssertEqual(redirect.scheme, "tsurfing")
        XCTAssertEqual(redirect.host, "auth")
        XCTAssertEqual(redirect.path, "/callback")
        XCTAssertEqual(redirect.queryItems, [URLQueryItem(name: "state", value: pending.state)])
    }

    func test_telegram_activation_is_bound_and_verified_before_session_becomes_usable() async throws {
        let store = makeStore()
        defer { clear(store) }
        let service = makeService(store: store, telegramEnabled: true)
        var paths: [String] = []

        setHandler { request in
            paths.append(request.url!.path)
            switch request.url!.path {
            case "/api/v1/auth/telegram/preflight":
                let body = try Self.jsonBody(request)
                XCTAssertEqual(Set(body.keys), Set(["code", "captchaToken"]))
                XCTAssertEqual(body["code"] as? String, "invite-code")
                XCTAssertEqual(body["captchaToken"] as? String, "captcha-proof-token-12345")
                return self.response(request, status: 202, object: [
                    "provider": "custom:telegram",
                    "attemptToken": self.attemptToken,
                    "expiresInSeconds": 600
                ])
            case "/auth/v1/token":
                let body = try Self.jsonBody(request)
                XCTAssertEqual(body["auth_code"] as? String, "telegram-auth-code")
                XCTAssertEqual(body["code_verifier"] as? String, try store.readPendingRequest()?.verifier)
                return self.response(request, object: self.tokenResponse())
            case "/api/v1/auth/telegram/activate":
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(self.accessToken())")
                XCTAssertEqual(try Self.jsonBody(request)["attemptToken"] as? String, self.attemptToken)
                return self.response(request, object: ["activated": true])
            case "/api/v1/session":
                return self.response(request, object: self.activeProfile())
            default:
                throw URLError(.unsupportedURL)
            }
        }

        _ = try await service.beginTelegramActivation(
            inviteCode: "invite-code",
            captchaToken: "captcha-proof-token-12345"
        )
        let pending = try XCTUnwrap(store.readPendingRequest())
        XCTAssertEqual(pending.flow, .telegramActivation)
        XCTAssertEqual(pending.attemptToken, attemptToken)
        XCTAssertFalse(store.isAuthenticated)

        let profile = try await service.handleCallback(url: callbackURL(for: pending))

        XCTAssertEqual(profile.userId, userId)
        XCTAssertTrue(store.isAuthenticated)
        XCTAssertNil(try store.readPendingRequest())
        XCTAssertEqual(paths, [
            "/api/v1/auth/telegram/preflight",
            "/auth/v1/token",
            "/api/v1/auth/telegram/activate",
            "/api/v1/session"
        ])
    }

    func test_lost_telegram_activation_ack_resumes_without_reusing_pkce_code() async throws {
        let store = makeStore()
        defer { clear(store) }
        let service = makeService(store: store, telegramEnabled: true)
        var exchangeCount = 0
        var activationCount = 0

        setHandler { request in
            switch request.url!.path {
            case "/api/v1/auth/telegram/preflight":
                return self.response(request, status: 202, object: [
                    "provider": "custom:telegram",
                    "attemptToken": self.attemptToken,
                    "expiresInSeconds": 600
                ])
            case "/auth/v1/token":
                exchangeCount += 1
                return self.response(request, object: self.tokenResponse())
            case "/api/v1/auth/telegram/activate":
                activationCount += 1
                return self.response(
                    request,
                    status: activationCount == 1 ? 503 : 200,
                    object: activationCount == 1 ? ["error": "unavailable"] : ["activated": true]
                )
            case "/api/v1/session":
                return self.response(request, object: self.activeProfile())
            default:
                throw URLError(.unsupportedURL)
            }
        }

        _ = try await service.beginTelegramActivation(
            inviteCode: "invite-code",
            captchaToken: "captcha-proof-token-12345"
        )
        let pending = try XCTUnwrap(store.readPendingRequest())
        do {
            _ = try await service.handleCallback(url: callbackURL(for: pending))
            XCTFail("Expected the first activation acknowledgement to fail")
        } catch AuthError.transient {}

        XCTAssertNotNil(try store.read())
        XCTAssertNotNil(try store.readPendingRequest())
        XCTAssertFalse(store.isAuthenticated)
        let profile = try await service.resumePendingTelegramFlow()
        XCTAssertEqual(profile?.userId, userId)
        XCTAssertEqual(exchangeCount, 1)
        XCTAssertEqual(activationCount, 2)
        XCTAssertTrue(store.isAuthenticated)
    }

    func test_telegram_link_authorization_is_authenticated_and_user_bound() async throws {
        let store = makeStore()
        defer { clear(store) }
        let service = makeService(store: store, telegramEnabled: true)
        let existing = try nativeSession()
        try store.save(existing)
        var linkAuthorizationRequest: URLRequest?

        setHandler { request in
            switch request.url!.path {
            case "/api/v1/session":
                return self.response(request, object: self.activeProfile())
            case "/auth/v1/user":
                return self.response(request, object: [
                    "id": self.userId,
                    "email": "person@example.invalid",
                    "identities": []
                ])
            case "/auth/v1/user/identities/authorize":
                linkAuthorizationRequest = request
                return self.response(request, object: ["url": "https://oauth.telegram.org/auth?request=test"])
            default:
                throw URLError(.unsupportedURL)
            }
        }

        let providerURL = try await service.beginTelegramLink()
        let request = try XCTUnwrap(linkAuthorizationRequest)
        let pending = try XCTUnwrap(store.readPendingRequest())
        let query = try XCTUnwrap(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems)
        let values = Dictionary(uniqueKeysWithValues: query.map { ($0.name, $0.value ?? "") })

        XCTAssertEqual(providerURL?.host, "oauth.telegram.org")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(existing.accessToken)")
        XCTAssertEqual(values["provider"], "custom:telegram")
        XCTAssertEqual(values["skip_http_redirect"], "true")
        XCTAssertEqual(values["code_challenge_method"], "s256")
        XCTAssertNil(values["origin"])
        XCTAssertNil(values["bot_id"])
        XCTAssertEqual(pending.flow, .telegramLink)
        XCTAssertEqual(pending.expectedUserId, userId)
        XCTAssertEqual(try store.read(), existing)
    }

    func test_cross_user_telegram_link_callback_preserves_original_session() async throws {
        let store = makeStore()
        defer { clear(store) }
        let service = makeService(store: store, telegramEnabled: true)
        let existing = try nativeSession()
        try store.save(existing)
        let otherUserId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

        setHandler { request in
            switch request.url!.path {
            case "/api/v1/session":
                return self.response(request, object: self.activeProfile())
            case "/auth/v1/user":
                return self.response(request, object: ["id": self.userId, "identities": []])
            case "/auth/v1/user/identities/authorize":
                return self.response(request, object: ["url": "https://oauth.telegram.org/auth?request=test"])
            case "/auth/v1/token":
                return self.response(request, object: self.tokenResponse(userId: otherUserId))
            default:
                throw URLError(.unsupportedURL)
            }
        }

        _ = try await service.beginTelegramLink()
        let pending = try XCTUnwrap(store.readPendingRequest())
        do {
            _ = try await service.handleCallback(url: callbackURL(for: pending))
            XCTFail("Expected the cross-user callback to fail")
        } catch KeychainError.invalidSession {}

        XCTAssertEqual(try store.read(), existing)
        XCTAssertNil(try store.readPendingRequest())
        XCTAssertTrue(store.isAuthenticated)
    }

    func test_mfa_required_response_does_not_erase_valid_session() async throws {
        let store = makeStore()
        defer { clear(store) }
        let service = makeService(store: store, telegramEnabled: true)
        let existing = try nativeSession()
        try store.save(existing)
        setHandler { request in
            self.response(request, status: 403, object: [
                "error": ["code": "mfa_required", "message": "MFA required"]
            ])
        }

        do {
            _ = try await service.validateCurrentSession()
            XCTFail("Expected MFA to be required")
        } catch AuthError.mfaRequired {}

        XCTAssertEqual(try store.read(), existing)
        XCTAssertTrue(store.isAuthenticated)
    }

    private func makeStore() -> KeychainSessionStore {
        KeychainSessionStore(
            service: "tsurfing.email-otp-test.\(UUID().uuidString.lowercased())",
            memoryBackend: KeychainMemoryBackend()
        )
    }

    private func clear(_ store: KeychainSessionStore) {
        try? store.clear()
        try? store.clearPendingEmailOtp()
        try? store.clearPendingRequest()
    }

    private func makeService(store: KeychainSessionStore, telegramEnabled: Bool = false) -> SupabaseAuthService {
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [AuthURLProtocolStub.self]
        return SupabaseAuthService(
            configuration: MacCloudConfiguration(
                apiOrigin: "https://app.tsurfing.test",
                supabaseURL: "https://project.supabase.co",
                publishableKey: "sb_publishable_tsurfing_test_only_value",
                telegramEnabled: telegramEnabled
            ),
            keychain: store,
            urlSession: URLSession(configuration: sessionConfiguration)
        )
    }

    private func setHandler(_ handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) {
        AuthURLProtocolStub.lock.lock()
        AuthURLProtocolStub.handler = handler
        AuthURLProtocolStub.lock.unlock()
    }

    private func response(
        _ request: URLRequest,
        status: Int = 200,
        object: [String: Any]
    ) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        return (response, try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
    }

    private func tokenResponse(
        userId: String? = nil,
        sessionId: String? = nil,
        assuranceLevel: String = "aal1"
    ) -> [String: Any] {
        let responseUserId = userId ?? self.userId
        return [
            "access_token": accessToken(
                userId: responseUserId,
                sessionId: sessionId ?? self.sessionId,
                assuranceLevel: assuranceLevel
            ),
            "refresh_token": "refresh-token",
            "expires_in": 3600,
            "user": ["id": responseUserId, "email": "person@example.invalid"]
        ]
    }

    private func accessToken(
        userId: String? = nil,
        sessionId: String? = nil,
        assuranceLevel: String = "aal1"
    ) -> String {
        let payload: [String: Any] = [
            "iss": "https://project.supabase.co/auth/v1",
            "sub": userId ?? self.userId,
            "session_id": sessionId ?? self.sessionId,
            "aud": "authenticated",
            "aal": assuranceLevel,
            "exp": 4_102_444_800
        ]
        let data = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        return [Data("{}".utf8).base64URLEncodedString(), data.base64URLEncodedString(), "signature"].joined(separator: ".")
    }

    private func nativeSession() throws -> NativeSession {
        let data = try JSONSerialization.data(withJSONObject: tokenResponse(), options: [.sortedKeys])
        return try parseNativeSessionResponse(
            data,
            configuration: MacCloudConfiguration(
                apiOrigin: "https://app.tsurfing.test",
                supabaseURL: "https://project.supabase.co",
                publishableKey: "sb_publishable_tsurfing_test_only_value",
                telegramEnabled: true
            )
        )
    }

    private func activeProfile() -> [String: Any] {
        [
            "user": [
                "id": userId,
                "email": "person@example.invalid",
                "role": "beta",
                "status": "active"
            ],
            "assuranceLevel": "aal1"
        ]
    }

    private func callbackURL(for pending: PendingPKCERequest, code: String = "telegram-auth-code") -> URL {
        var components = URLComponents(string: MacCloudConfiguration.authRedirectURL)!
        components.queryItems = [
            URLQueryItem(name: "code", value: code),
            URLQueryItem(name: "state", value: pending.state)
        ]
        return components.url!
    }

    private static func jsonBody(_ request: URLRequest) throws -> [String: Any] {
        let data: Data
        if let body = request.httpBody {
            data = body
        } else if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var collected = Data()
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4_096)
            defer { buffer.deallocate() }
            while stream.hasBytesAvailable {
                let count = stream.read(buffer, maxLength: 4_096)
                if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeContentData) }
                if count == 0 { break }
                collected.append(buffer, count: count)
            }
            data = collected
        } else {
            throw URLError(.cannotDecodeContentData)
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
