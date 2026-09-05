import Foundation
import CryptoKit
import Security

struct GoalflowSessionProfile: Equatable, Sendable {
    var userId: String
    var email: String
    var role: String
    var assuranceLevel: String

    var requiresMFA: Bool { role == "owner" && assuranceLevel != "aal2" }
}

struct MacTelegramStatus: Equatable, Sendable {
    var enabled: Bool
    var linked: Bool
    var username: String?
}

func pkceChallenge(_ verifier: String) -> String {
    Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()
}

func timingSafeEqual(_ left: String, _ right: String) -> Bool {
    let lhs = Array(left.utf8)
    let rhs = Array(right.utf8)
    guard lhs.count == rhs.count else { return false }
    var difference: UInt8 = 0
    for index in lhs.indices { difference |= lhs[index] ^ rhs[index] }
    return difference == 0
}

final class SupabaseAuthService: @unchecked Sendable {
    static let shared = SupabaseAuthService()

    private let configuration: MacCloudConfiguration
    private let keychain: KeychainSessionStore
    private let urlSession: URLSession

    init(
        configuration: MacCloudConfiguration = .current,
        keychain: KeychainSessionStore = KeychainSessionStore(),
        urlSession: URLSession? = nil
    ) {
        self.configuration = configuration
        self.keychain = keychain
        if let urlSession {
            self.urlSession = urlSession
        } else {
            let sessionConfiguration = URLSessionConfiguration.ephemeral
            sessionConfiguration.timeoutIntervalForRequest = 15
            sessionConfiguration.timeoutIntervalForResource = 20
            sessionConfiguration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            self.urlSession = URLSession(
                configuration: sessionConfiguration,
                delegate: NoRedirectURLSessionDelegate(),
                delegateQueue: nil
            )
        }
    }

    var isConfigured: Bool { configuration.isCloudConfigured }
    var isTelegramConfigured: Bool { configuration.isTelegramConfigured }
    var configurationProblem: String? { configuration.problem }
    var nativeCaptchaURL: URL? {
        guard let origin = configuration.apiOrigin else { return nil }
        return URL(string: "/api/v1/auth/email/captcha", relativeTo: origin)?.absoluteURL
    }

    func requestEmailCode(
        email: String,
        purpose: PendingEmailOtpAttempt.Purpose,
        inviteCode: String = "",
        captchaToken: String
    ) async throws -> PendingEmailOtpAttempt {
        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard cleanEmail.count <= 254,
              cleanEmail.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) != nil else {
            throw AuthError.invalidEmail
        }
        let cleanInvite = inviteCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard purpose != .activation || (6...128).contains(cleanInvite.count) else {
            throw AuthError.invalidInvite
        }
        guard captchaToken.range(of: #"^[A-Za-z0-9._~-]{20,4096}$"#, options: .regularExpression) != nil else {
            throw AuthError.captchaRequired
        }
        let auth = try requireAuthenticationConfiguration()
        guard let apiOrigin = configuration.apiOrigin,
              let url = URL(string: "/api/v1/auth/email/preflight", relativeTo: apiOrigin)?.absoluteURL else {
            throw AuthError.notConfigured
        }
        let body = try JSONSerialization.data(withJSONObject: [
            "email": cleanEmail,
            "purpose": purpose.rawValue,
            "code": purpose == .activation ? cleanInvite : "",
            "captchaToken": captchaToken
        ])
        let (data, response) = try await request(
            url: url,
            method: "POST",
            body: body,
            publishableKey: auth.key
        )
        guard (200..<300).contains(response.statusCode), data.count <= 64 * 1024,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["accepted"] as? Bool == true,
              let attemptToken = object["attemptToken"] as? String,
              attemptToken.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil,
              let expiresIn = (object["expiresInSeconds"] as? NSNumber)?.doubleValue,
              expiresIn > 0, expiresIn <= 600,
              let resendAfter = (object["resendAfterSeconds"] as? NSNumber)?.doubleValue,
              resendAfter >= 60, resendAfter <= 600 else {
            if Self.isRetryable(response.statusCode) { throw AuthError.transient }
            throw AuthError.deliveryUnconfirmed
        }
        let pending = PendingEmailOtpAttempt(
            attemptToken: attemptToken,
            email: cleanEmail,
            purpose: purpose,
            expiresAt: Date().addingTimeInterval(expiresIn),
            resendAt: Date().addingTimeInterval(resendAfter)
        )
        try abandonPendingAccountAuthentication()
        try keychain.savePendingEmailOtp(pending)
        return pending
    }

    func pendingEmailCodeRequest() throws -> PendingEmailOtpAttempt? {
        try keychain.readPendingEmailOtp()
    }

    func verifyEmailCode(email: String, code: String) async throws -> GoalflowSessionProfile {
        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let cleanCode = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let pending = try keychain.readPendingEmailOtp(),
              timingSafeEqual(pending.email, cleanEmail),
              pending.expiresAt > Date(),
              cleanCode.range(of: #"^[0-9]{6}$"#, options: .regularExpression) != nil else {
            throw AuthError.invalidEmailCode
        }
        if let existing = try keychain.read(), pending.matchesVerifiedSession(existing) {
            try await activateEmailOtp(session: existing, pending: pending)
            return try await validateCurrentSession()
        }

        let auth = try requireAuthenticationConfiguration()
        let url = auth.url.appendingPathComponent("auth/v1/verify")
        let body = try JSONSerialization.data(withJSONObject: [
            "email": cleanEmail,
            "token": cleanCode,
            "type": "email"
        ])
        let (data, response) = try await request(
            url: url,
            method: "POST",
            body: body,
            publishableKey: auth.key
        )
        guard (200..<300).contains(response.statusCode) else {
            if Self.isRetryable(response.statusCode) { throw AuthError.transient }
            throw AuthError.invalidEmailCode
        }
        guard data.count <= 256 * 1024,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let returnedEmail = (object["user"] as? [String: Any])?["email"] as? String,
              timingSafeEqual(returnedEmail.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), cleanEmail) else {
            throw AuthError.invalidResponse
        }
        let session = try parseNativeSessionResponse(data, configuration: configuration)
        try keychain.save(session)
        let verifiedPending = pending.verified(by: session)
        try keychain.savePendingEmailOtp(verifiedPending)
        try await activateEmailOtp(session: session, pending: verifiedPending)
        NotificationCenter.default.post(name: .authDidChange, object: nil)
        return try await validateCurrentSession()
    }

    @discardableResult
    func resumePendingEmailActivation() async throws -> Bool {
        guard let pending = try keychain.readPendingEmailOtp(),
              let session = try keychain.read(),
              pending.matchesVerifiedSession(session) else { return false }
        // The server decides expiry. An activation committed before a lost
        // acknowledgement remains idempotent after the local timer elapsed.
        try await activateEmailOtp(session: session, pending: pending)
        NotificationCenter.default.post(name: .authDidChange, object: nil)
        return true
    }

    func beginTelegramSignIn() throws -> URL {
        let pending = try makeTelegramRequest(flow: .telegramSignIn)
        try abandonPendingAccountAuthentication()
        try keychain.savePendingRequest(pending)
        return try telegramAuthorizationURL(for: pending, linkIdentity: false)
    }

    func beginTelegramActivation(inviteCode: String, captchaToken: String) async throws -> URL {
        let telegram = try requireTelegramConfiguration()
        let cleanInvite = inviteCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (6...128).contains(cleanInvite.count) else { throw AuthError.invalidInvite }
        guard captchaToken.range(
            of: #"^[A-Za-z0-9._~-]{20,4096}$"#,
            options: .regularExpression
        ) != nil else { throw AuthError.captchaRequired }
        guard let apiOrigin = configuration.apiOrigin,
              let url = URL(string: "/api/v1/auth/telegram/preflight", relativeTo: apiOrigin)?.absoluteURL else {
            throw AuthError.notConfigured
        }
        let body = try JSONSerialization.data(withJSONObject: [
            "code": cleanInvite,
            "captchaToken": captchaToken
        ])
        let (data, response) = try await request(
            url: url,
            method: "POST",
            body: body,
            publishableKey: telegram.key
        )
        guard (200..<300).contains(response.statusCode), data.count <= 64 * 1024,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["provider"] as? String == telegram.provider,
              let attemptToken = object["attemptToken"] as? String,
              attemptToken.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil,
              let expiresIn = (object["expiresInSeconds"] as? NSNumber)?.doubleValue,
              expiresIn > 0, expiresIn <= 600 else {
            if Self.isRetryable(response.statusCode) { throw AuthError.transient }
            throw AuthError.telegramActivationRejected
        }
        let pending = try makeTelegramRequest(
            flow: .telegramActivation,
            expiresIn: expiresIn,
            attemptToken: attemptToken
        )
        try abandonPendingAccountAuthentication()
        try keychain.savePendingRequest(pending)
        return try telegramAuthorizationURL(for: pending, linkIdentity: false)
    }

    /// Returns nil when the provider identity already existed and server-side
    /// bot access was linked without opening a browser.
    func beginTelegramLink() async throws -> URL? {
        let telegram = try requireTelegramConfiguration()
        let profile = try await validateCurrentSession()
        if profile.requiresMFA { throw AuthError.mfaRequired }
        let session = try await keychain.currentSession(configuration: configuration, urlSession: urlSession)
        let userURL = telegram.url.appendingPathComponent("auth/v1/user")
        let (userData, userResponse) = try await request(
            url: userURL,
            method: "GET",
            body: nil,
            publishableKey: telegram.key,
            bearerToken: session.accessToken
        )
        try requireAuthenticatedResponse(
            data: userData,
            response: userResponse,
            session: session,
            fallback: .telegramLinkRejected
        )
        guard userData.count <= 256 * 1024,
              let user = try? JSONSerialization.jsonObject(with: userData) as? [String: Any],
              (user["id"] as? String)?.lowercased() == session.userId else {
            throw AuthError.invalidResponse
        }
        let acceptedProviders = Set([telegram.provider, telegram.provider.replacingOccurrences(of: "custom:", with: "")])
        let identities = user["identities"] as? [[String: Any]] ?? []
        if identities.contains(where: { identity in
            guard let provider = identity["provider"] as? String else { return false }
            return acceptedProviders.contains(provider)
        }) {
            try await activateTelegramLink(session: session)
            return nil
        }

        let pending = try makeTelegramRequest(
            flow: .telegramLink,
            expectedUserId: session.userId
        )
        try keychain.savePendingRequest(pending)
        let endpoint = try telegramAuthorizationURL(for: pending, linkIdentity: true)
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await request(
                url: endpoint,
                method: "GET",
                body: nil,
                publishableKey: telegram.key,
                bearerToken: session.accessToken
            )
            try requireAuthenticatedResponse(
                data: data,
                response: response,
                session: session,
                fallback: .telegramLinkRejected
            )
        } catch AuthError.transient {
            throw AuthError.transient
        } catch {
            try? keychain.clearPendingRequest()
            throw error
        }
        guard data.count <= 64 * 1024,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let providerURLString = object["url"] as? String,
              let providerURL = URL(string: providerURLString),
              let components = URLComponents(url: providerURL, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "https",
              components.host?.isEmpty == false,
              components.user == nil, components.password == nil,
              components.fragment == nil else {
            try? keychain.clearPendingRequest()
            throw AuthError.invalidResponse
        }
        return providerURL
    }

    func telegramStatus() async throws -> MacTelegramStatus {
        let telegram = try requireTelegramConfiguration()
        let session = try await keychain.currentSession(configuration: configuration, urlSession: urlSession)
        guard let apiOrigin = configuration.apiOrigin,
              let url = URL(string: "/api/v1/account/telegram", relativeTo: apiOrigin)?.absoluteURL else {
            throw AuthError.notConfigured
        }
        let (data, response) = try await request(
            url: url,
            method: "GET",
            body: nil,
            publishableKey: telegram.key,
            bearerToken: session.accessToken
        )
        try requireAuthenticatedResponse(
            data: data,
            response: response,
            session: session,
            fallback: .telegramStatusUnavailable
        )
        guard data.count <= 64 * 1024,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let enabled = object["enabled"] as? Bool,
              let linked = object["linked"] as? Bool else { throw AuthError.invalidResponse }
        return MacTelegramStatus(
            enabled: enabled,
            linked: linked,
            username: (object["username"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    func unlinkTelegram() async throws -> MacTelegramStatus {
        let telegram = try requireTelegramConfiguration()
        let profile = try await validateCurrentSession()
        if profile.requiresMFA { throw AuthError.mfaRequired }
        let session = try await keychain.currentSession(configuration: configuration, urlSession: urlSession)
        guard let apiOrigin = configuration.apiOrigin,
              let url = URL(string: "/api/v1/account/telegram/link", relativeTo: apiOrigin)?.absoluteURL else {
            throw AuthError.notConfigured
        }
        let (data, response) = try await request(
            url: url,
            method: "DELETE",
            body: nil,
            publishableKey: telegram.key,
            bearerToken: session.accessToken
        )
        try requireAuthenticatedResponse(
            data: data,
            response: response,
            session: session,
            fallback: .telegramLinkRejected
        )
        return MacTelegramStatus(enabled: true, linked: false, username: nil)
    }

    @discardableResult
    func resumePendingTelegramFlow() async throws -> GoalflowSessionProfile? {
        guard let pending = try keychain.readPendingRequest(),
              [.telegramSignIn, .telegramActivation, .telegramLink].contains(pending.flow),
              let session = try keychain.read(),
              pending.matchesVerifiedSession(session) else { return nil }
        return try await finishTelegramFlow(session: session, pending: pending)
    }

    private func activateEmailOtp(session: NativeSession, pending: PendingEmailOtpAttempt) async throws {
        guard pending.matchesVerifiedSession(session) else { throw AuthError.emailCodeRequired }
        let auth = try requireAuthenticationConfiguration()
        guard let apiOrigin = configuration.apiOrigin,
              let url = URL(string: "/api/v1/auth/email/activate", relativeTo: apiOrigin)?.absoluteURL else {
            throw AuthError.notConfigured
        }
        let body = try JSONSerialization.data(withJSONObject: ["attemptToken": pending.attemptToken])
        let (data, response) = try await request(
            url: url,
            method: "POST",
            body: body,
            publishableKey: auth.key,
            bearerToken: session.accessToken
        )
        guard try keychain.read()?.accessToken == session.accessToken else { throw AuthError.sessionChanged }
        if (200..<300).contains(response.statusCode), data.count <= 64 * 1024,
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           object["activated"] as? Bool == true {
            try keychain.clearPendingEmailOtp()
            return
        }
        if Self.isRetryable(response.statusCode) { throw AuthError.transient }
        try keychain.clearIfAccessTokenMatches(session.accessToken)
        try keychain.clearPendingEmailOtp()
        throw AuthError.activationRejected
    }

    private func makeTelegramRequest(
        flow: PendingPKCERequest.Flow,
        expiresIn: TimeInterval = 10 * 60,
        attemptToken: String? = nil,
        expectedUserId: String? = nil
    ) throws -> PendingPKCERequest {
        guard [.telegramSignIn, .telegramActivation, .telegramLink].contains(flow),
              flow != .telegramLink || expectedUserId.flatMap(UUID.init(uuidString:)) != nil else {
            throw AuthError.invalidResponse
        }
        let state = try secureRandomValue()
        var callback = URLComponents(string: MacCloudConfiguration.authRedirectURL)!
        callback.queryItems = [URLQueryItem(name: "state", value: state)]
        guard let redirectURL = callback.url?.absoluteString else { throw AuthError.notConfigured }
        let createdAt = Date()
        return PendingPKCERequest(
            state: state,
            verifier: try secureRandomValue(),
            redirectURL: redirectURL,
            createdAt: createdAt,
            flow: flow,
            expiresAt: createdAt.addingTimeInterval(min(max(expiresIn, 1), 15 * 60)),
            attemptToken: attemptToken,
            expectedUserId: expectedUserId?.lowercased()
        )
    }

    private func telegramAuthorizationURL(
        for pending: PendingPKCERequest,
        linkIdentity: Bool
    ) throws -> URL {
        let telegram = try requireTelegramConfiguration()
        let path = linkIdentity ? "/auth/v1/user/identities/authorize" : "/auth/v1/authorize"
        guard let endpoint = URL(string: path, relativeTo: telegram.url)?.absoluteURL,
              var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
            throw AuthError.notConfigured
        }
        components.queryItems = [
            URLQueryItem(name: "provider", value: telegram.provider),
            URLQueryItem(name: "redirect_to", value: pending.redirectURL),
            URLQueryItem(name: "scopes", value: "openid profile telegram:bot_access"),
            URLQueryItem(name: "code_challenge", value: pkceChallenge(pending.verifier)),
            URLQueryItem(name: "code_challenge_method", value: "s256")
        ]
        if linkIdentity {
            components.queryItems?.append(URLQueryItem(name: "skip_http_redirect", value: "true"))
        }
        guard let url = components.url else { throw AuthError.notConfigured }
        return url
    }

    private func abandonPendingAccountAuthentication() throws {
        let session = try keychain.read()
        let pendingEmail = try keychain.readPendingEmailOtp()
        let pendingOAuth = try keychain.readPendingRequest()
        if let session,
           pendingEmail?.matchesVerifiedSession(session) == true
            || (pendingOAuth?.flow.blocksSession == true
                && pendingOAuth?.matchesVerifiedSession(session) == true) {
            try keychain.clearIfAccessTokenMatches(session.accessToken)
        }
        try keychain.clearPendingEmailOtp()
        try keychain.clearPendingRequest()
    }

    private func finishTelegramFlow(
        session: NativeSession,
        pending: PendingPKCERequest
    ) async throws -> GoalflowSessionProfile {
        guard pending.matchesVerifiedSession(session) else { throw AuthError.sessionChanged }
        do {
            switch pending.flow {
            case .telegramActivation:
                try await activateTelegramBeta(session: session, pending: pending)
            case .telegramLink:
                guard pending.expectedUserId?.lowercased() == session.userId else {
                    throw AuthError.sessionChanged
                }
                try await activateTelegramLink(session: session)
            case .telegramSignIn:
                break
            case .magicLink, .browser:
                throw AuthError.callbackNotRequested
            }
            let profile = try await validateServerSession(session)
            try keychain.clearPendingRequest()
            return profile
        } catch AuthError.transient {
            throw AuthError.transient
        } catch {
            try? keychain.clearPendingRequest()
            if pending.flow != .telegramLink {
                try? keychain.clearIfAccessTokenMatches(session.accessToken)
            }
            throw error
        }
    }

    private func activateTelegramBeta(session: NativeSession, pending: PendingPKCERequest) async throws {
        let telegram = try requireTelegramConfiguration()
        guard let attemptToken = pending.attemptToken,
              attemptToken.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil,
              let apiOrigin = configuration.apiOrigin,
              let url = URL(string: "/api/v1/auth/telegram/activate", relativeTo: apiOrigin)?.absoluteURL else {
            throw AuthError.telegramActivationRejected
        }
        let body = try JSONSerialization.data(withJSONObject: ["attemptToken": attemptToken])
        let (data, response) = try await request(
            url: url,
            method: "POST",
            body: body,
            publishableKey: telegram.key,
            bearerToken: session.accessToken
        )
        try requireAuthenticatedResponse(
            data: data,
            response: response,
            session: session,
            fallback: .telegramActivationRejected
        )
        guard data.count <= 64 * 1024,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["activated"] as? Bool == true else {
            throw AuthError.telegramActivationRejected
        }
    }

    private func activateTelegramLink(session: NativeSession) async throws {
        let telegram = try requireTelegramConfiguration()
        guard let apiOrigin = configuration.apiOrigin,
              let url = URL(string: "/api/v1/account/telegram/link", relativeTo: apiOrigin)?.absoluteURL else {
            throw AuthError.notConfigured
        }
        let (data, response) = try await request(
            url: url,
            method: "POST",
            body: nil,
            publishableKey: telegram.key,
            bearerToken: session.accessToken
        )
        try requireAuthenticatedResponse(
            data: data,
            response: response,
            session: session,
            fallback: .telegramLinkRejected
        )
        guard data.count <= 64 * 1024,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["linked"] as? Bool == true else { throw AuthError.telegramLinkRejected }
    }

    func handleCallback(url: URL) async throws -> GoalflowSessionProfile {
        guard Self.isExpectedCallbackURL(url), url.fragment == nil else {
            throw AuthError.invalidCallback
        }
        let pending = try keychain.readPendingRequest()
        guard let pending,
              pending.effectiveExpiresAt > Date(),
              pending.verifier.count >= 43, pending.verifier.count <= 128 else {
            throw AuthError.callbackNotRequested
        }
        var expectedRedirect = URLComponents(string: MacCloudConfiguration.authRedirectURL)!
        expectedRedirect.queryItems = [URLQueryItem(name: "state", value: pending.state)]
        guard pending.redirectURL == expectedRedirect.url?.absoluteString else {
            throw AuthError.callbackNotRequested
        }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let codes = components?.queryItems?.filter { $0.name == "code" }.compactMap(\.value) ?? []
        let states = components?.queryItems?.filter { $0.name == "state" }.compactMap(\.value) ?? []
        guard codes.count == 1, states.count == 1,
              !codes[0].isEmpty, codes[0].count <= 2_048,
              timingSafeEqual(states[0], pending.state) else {
            throw AuthError.invalidCallback
        }
        let auth = try requireAuthenticationConfiguration()
        var endpoint = URLComponents(url: auth.url.appendingPathComponent("auth/v1/token"), resolvingAgainstBaseURL: false)!
        endpoint.queryItems = [URLQueryItem(name: "grant_type", value: "pkce")]
        guard let tokenURL = endpoint.url else { throw AuthError.notConfigured }
        let body = try JSONSerialization.data(withJSONObject: [
            "auth_code": codes[0],
            "code_verifier": pending.verifier
        ])
        let (data, response) = try await request(
            url: tokenURL,
            method: "POST",
            body: body,
            publishableKey: auth.key
        )
        guard (200..<300).contains(response.statusCode) else {
            if Self.isRetryable(response.statusCode) { throw AuthError.transient }
            try keychain.clearPendingRequest()
            throw AuthError.invalidOrExpiredLink
        }
        let session: NativeSession
        do {
            session = try parseNativeSessionResponse(
                data,
                configuration: configuration,
                expectedUserId: pending.flow == .telegramLink ? pending.expectedUserId : nil
            )
        } catch {
            try? keychain.clearPendingRequest()
            throw error
        }
        if pending.flow == .magicLink || pending.flow == .browser {
            try keychain.save(session)
            try keychain.clearPendingRequest()
            NotificationCenter.default.post(name: .authDidChange, object: nil)
            return try await validateServerSession(session)
        }
        _ = try requireTelegramConfiguration()
        try keychain.save(session)
        let verifiedPending = pending.verified(by: session)
        try keychain.savePendingRequest(verifiedPending)
        let profile = try await finishTelegramFlow(session: session, pending: verifiedPending)
        NotificationCenter.default.post(name: .authDidChange, object: nil)
        return profile
    }

    func validateCurrentSession() async throws -> GoalflowSessionProfile {
        _ = try await resumePendingEmailActivation()
        _ = try await resumePendingTelegramFlow()
        let session = try await keychain.currentSession(configuration: configuration, urlSession: urlSession)
        return try await validateServerSession(session)
    }

    private func validateServerSession(_ session: NativeSession) async throws -> GoalflowSessionProfile {
        let auth = try requireAuthenticationConfiguration()
        guard let apiOrigin = configuration.apiOrigin,
              let url = URL(string: "/api/v1/session", relativeTo: apiOrigin)?.absoluteURL else {
            throw AuthError.notConfigured
        }
        let (data, response) = try await request(
            url: url,
            method: "GET",
            body: nil,
            publishableKey: auth.key,
            bearerToken: session.accessToken
        )
        let current = try keychain.read()
        guard current?.userId == session.userId else { throw AuthError.sessionChanged }
        try requireAuthenticatedResponse(
            data: data,
            response: response,
            session: session,
            fallback: .invalidResponse
        )
        guard (200..<300).contains(response.statusCode), data.count <= 64 * 1024,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let user = object["user"] as? [String: Any],
              let userId = user["id"] as? String,
              let email = user["email"] as? String,
              let role = user["role"] as? String,
              user["status"] as? String == "active",
              let assuranceLevel = object["assuranceLevel"] as? String,
              userId.lowercased() == session.userId else {
            if Self.isRetryable(response.statusCode) { throw AuthError.transient }
            throw AuthError.invalidResponse
        }
        return GoalflowSessionProfile(
            userId: userId.lowercased(),
            email: email,
            role: role,
            assuranceLevel: assuranceLevel
        )
    }

    func completeMFA(code: String) async throws -> GoalflowSessionProfile {
        let cleanCode = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleanCode.range(of: #"^[0-9]{6}$"#, options: .regularExpression) != nil else {
            throw AuthError.invalidMFACode
        }
        let auth = try requireAuthenticationConfiguration()
        let session = try await keychain.currentSession(configuration: configuration, urlSession: urlSession)
        let userURL = auth.url.appendingPathComponent("auth/v1/user")
        let (userData, userResponse) = try await request(
            url: userURL,
            method: "GET",
            body: nil,
            publishableKey: auth.key,
            bearerToken: session.accessToken
        )
        guard (200..<300).contains(userResponse.statusCode),
              let user = try? JSONSerialization.jsonObject(with: userData) as? [String: Any],
              let factors = user["factors"] as? [[String: Any]],
              let factorId = factors.first(where: {
                  $0["factor_type"] as? String == "totp" && $0["status"] as? String == "verified"
              })?["id"] as? String,
              UUID(uuidString: factorId) != nil else {
            if userResponse.statusCode == 401 || userResponse.statusCode == 403 {
                try keychain.clearIfAccessTokenMatches(session.accessToken)
                NotificationCenter.default.post(name: .authDidChange, object: nil)
                throw AuthError.revoked
            }
            throw AuthError.mfaNotEnrolled
        }
        let factorURL = auth.url.appendingPathComponent("auth/v1/factors/\(factorId)")
        let challengeURL = factorURL.appendingPathComponent("challenge")
        let (challengeData, challengeResponse) = try await request(
            url: challengeURL,
            method: "POST",
            body: JSONSerialization.data(withJSONObject: ["factorId": factorId]),
            publishableKey: auth.key,
            bearerToken: session.accessToken
        )
        guard (200..<300).contains(challengeResponse.statusCode),
              let challenge = try? JSONSerialization.jsonObject(with: challengeData) as? [String: Any],
              let challengeId = challenge["id"] as? String, UUID(uuidString: challengeId) != nil else {
            if challengeResponse.statusCode == 401 || challengeResponse.statusCode == 403 {
                try keychain.clearIfAccessTokenMatches(session.accessToken)
                NotificationCenter.default.post(name: .authDidChange, object: nil)
                throw AuthError.revoked
            }
            throw Self.isRetryable(challengeResponse.statusCode) ? AuthError.transient : AuthError.invalidMFACode
        }
        let verifyURL = factorURL.appendingPathComponent("verify")
        let (verifyData, verifyResponse) = try await request(
            url: verifyURL,
            method: "POST",
            body: JSONSerialization.data(withJSONObject: ["challenge_id": challengeId, "code": cleanCode]),
            publishableKey: auth.key,
            bearerToken: session.accessToken
        )
        guard (200..<300).contains(verifyResponse.statusCode) else {
            if verifyResponse.statusCode == 401 || verifyResponse.statusCode == 403 {
                try keychain.clearIfAccessTokenMatches(session.accessToken)
                NotificationCenter.default.post(name: .authDidChange, object: nil)
                throw AuthError.revoked
            }
            throw Self.isRetryable(verifyResponse.statusCode) ? AuthError.transient : AuthError.invalidMFACode
        }
        let elevated = try parseNativeSessionResponse(
            verifyData,
            configuration: configuration,
            fallbackRefreshToken: session.refreshToken,
            expectedUserId: session.userId
        )
        guard elevated.assuranceLevel == "aal2" else { throw AuthError.invalidResponse }
        try keychain.save(elevated)
        NotificationCenter.default.post(name: .authDidChange, object: nil)
        let profile = try await validateCurrentSession()
        guard !profile.requiresMFA else { throw AuthError.invalidResponse }
        return profile
    }

    func signOut() async throws {
        let current = try keychain.read()
        // Stop authenticated requests first. Local task files and the durable
        // outbox are deliberately untouched.
        try keychain.clear()
        try keychain.clearPendingEmailOtp()
        try keychain.clearPendingRequest()
        NotificationCenter.default.post(name: .authDidChange, object: nil)
        guard let current else { return }
        let auth = try requireAuthenticationConfiguration()
        var endpoint = URLComponents(url: auth.url.appendingPathComponent("auth/v1/logout"), resolvingAgainstBaseURL: false)!
        endpoint.queryItems = [URLQueryItem(name: "scope", value: "local")]
        guard let url = endpoint.url else { throw AuthError.remoteLogoutUnconfirmed }
        do {
            let (_, response) = try await request(
                url: url,
                method: "POST",
                body: nil,
                publishableKey: auth.key,
                bearerToken: current.accessToken
            )
            guard (200..<300).contains(response.statusCode) || [401, 403, 404].contains(response.statusCode) else {
                throw AuthError.remoteLogoutUnconfirmed
            }
        } catch {
            throw AuthError.remoteLogoutUnconfirmed
        }
    }

    static func isExpectedCallbackURL(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let expected = URLComponents(string: MacCloudConfiguration.authRedirectURL) else { return false }
        return components.scheme?.lowercased() == expected.scheme?.lowercased()
            && components.host?.lowercased() == expected.host?.lowercased()
            && components.path == expected.path
            && components.user == nil
            && components.password == nil
            && components.port == nil
            && components.fragment == nil
    }

    private func requireAuthenticationConfiguration() throws -> (url: URL, key: String) {
        guard configuration.isCloudConfigured,
              let url = configuration.supabaseURL,
              let key = configuration.publishableKey else { throw AuthError.notConfigured }
        return (url, key)
    }

    private func requireTelegramConfiguration() throws -> (url: URL, key: String, provider: String) {
        let auth = try requireAuthenticationConfiguration()
        guard configuration.isTelegramConfigured else { throw AuthError.telegramNotConfigured }
        return (auth.url, auth.key, configuration.telegramProviderId)
    }

    private func requireAuthenticatedResponse(
        data: Data,
        response: HTTPURLResponse,
        session: NativeSession,
        fallback: AuthError
    ) throws {
        if (200..<300).contains(response.statusCode) { return }
        let errorCode = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])
            .flatMap { $0["error"] as? [String: Any] }?["code"] as? String
        if response.statusCode == 401
            || (response.statusCode == 403 && errorCode == "account_inactive") {
            try keychain.clearIfAccessTokenMatches(session.accessToken)
            NotificationCenter.default.post(name: .authDidChange, object: nil)
            throw AuthError.revoked
        }
        if response.statusCode == 403 && errorCode == "mfa_required" {
            throw AuthError.mfaRequired
        }
        if Self.isRetryable(response.statusCode) { throw AuthError.transient }
        throw fallback
    }

    private func request(
        url: URL,
        method: String,
        body: Data?,
        publishableKey: String,
        bearerToken: String? = nil
    ) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(publishableKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let bearerToken { request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization") }
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        request.httpBody = body
        do {
            let (data, response) = try await urlSession.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw AuthError.transient }
            return (data, http)
        } catch let error as AuthError {
            throw error
        } catch {
            throw AuthError.transient
        }
    }

    private func secureRandomValue() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw AuthError.randomnessUnavailable
        }
        return Data(bytes).base64URLEncodedString()
    }

    private static func isRetryable(_ status: Int) -> Bool {
        status >= 500 || [408, 425, 429].contains(status)
    }
}

enum AuthError: Error, LocalizedError {
    case notConfigured
    case invalidEmail
    case invalidInvite
    case captchaRequired
    case invalidEmailCode
    case emailCodeRequired
    case activationRejected
    case deliveryUnconfirmed
    case invalidCallback
    case callbackNotRequested
    case invalidOrExpiredLink
    case invalidResponse
    case transient
    case revoked
    case sessionChanged
    case randomnessUnavailable
    case mfaNotEnrolled
    case mfaRequired
    case invalidMFACode
    case remoteLogoutUnconfirmed
    case telegramNotConfigured
    case telegramActivationRejected
    case telegramLinkRejected
    case telegramStatusUnavailable
    case browserUnavailable

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Cloud authentication is not configured for this build."
        case .invalidEmail: return "Enter a valid email address."
        case .invalidInvite: return "Enter a valid beta invite."
        case .captchaRequired: return "Complete human verification before requesting an email code."
        case .invalidEmailCode: return "The email code is invalid or expired."
        case .emailCodeRequired: return "Enter the current email code before activating this session."
        case .activationRejected: return "This email-code request is invalid or expired."
        case .deliveryUnconfirmed: return "Email-code delivery could not be confirmed. Wait before requesting another code."
        case .invalidCallback: return "The browser sign-in callback was invalid. Start again."
        case .callbackNotRequested: return "This browser sign-in was not requested on this Mac, or it expired."
        case .invalidOrExpiredLink: return "The browser sign-in is invalid or expired. Start again."
        case .invalidResponse: return "The authentication service returned invalid data. Local changes were not modified."
        case .transient: return "Authentication is temporarily unavailable. Local changes remain on this Mac."
        case .revoked: return "This cloud session was revoked or the account is inactive. Local changes remain on this Mac."
        case .sessionChanged: return "The account changed while authentication was being verified."
        case .randomnessUnavailable: return "A secure sign-in request could not be created."
        case .mfaNotEnrolled: return "The owner account has no verified authenticator factor. Enroll MFA in the web app first."
        case .mfaRequired: return "Verify the owner session before using this action."
        case .invalidMFACode: return "The authenticator code was not accepted."
        case .remoteLogoutUnconfirmed: return "Signed out on this Mac, but server sign-out could not be confirmed."
        case .telegramNotConfigured: return "Telegram authentication is not configured for this build."
        case .telegramActivationRejected: return "Telegram beta activation is invalid, expired, or unavailable."
        case .telegramLinkRejected: return "Telegram could not be linked to this Tsurfing account."
        case .telegramStatusUnavailable: return "Telegram status could not be loaded."
        case .browserUnavailable: return "The system browser could not be opened. Start again."
        }
    }
}

extension Notification.Name {
    static let authDidChange = Notification.Name("goalflow.authDidChange")
}

private final class NoRedirectURLSessionDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
