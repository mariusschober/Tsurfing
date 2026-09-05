import Foundation
import Security

struct NativeSession: Codable, Equatable, Sendable {
    var accessToken: String
    var refreshToken: String
    var expiresAt: Date
    var userId: String
    var sessionId: String
    var assuranceLevel: String
}

struct PendingPKCERequest: Codable, Equatable, Sendable {
    enum Flow: String, Codable, Sendable {
        case magicLink
        case browser
        case telegramSignIn = "telegram_sign_in"
        case telegramActivation = "telegram_activation"
        case telegramLink = "telegram_link"

        var blocksSession: Bool { self == .telegramSignIn || self == .telegramActivation }
    }
    var state: String
    var verifier: String
    var redirectURL: String
    var createdAt: Date
    var flow: Flow
    var expiresAt: Date? = nil
    var attemptToken: String? = nil
    var expectedUserId: String? = nil
    var verifiedUserId: String? = nil
    var verifiedSessionId: String? = nil

    var effectiveExpiresAt: Date { expiresAt ?? createdAt.addingTimeInterval(15 * 60) }

    func matchesVerifiedSession(_ session: NativeSession) -> Bool {
        guard let verifiedUserId, let verifiedSessionId else { return false }
        return verifiedUserId.lowercased() == session.userId.lowercased()
            && verifiedSessionId.lowercased() == session.sessionId.lowercased()
    }

    func verified(by session: NativeSession) -> PendingPKCERequest {
        var result = self
        result.verifiedUserId = session.userId.lowercased()
        result.verifiedSessionId = session.sessionId.lowercased()
        return result
    }
}

struct PendingEmailOtpAttempt: Codable, Equatable, Sendable {
    enum Purpose: String, Codable, Sendable { case signIn = "sign_in", activation }
    var attemptToken: String
    var email: String
    var purpose: Purpose
    var expiresAt: Date
    var resendAt: Date
    var verifiedUserId: String? = nil
    var verifiedSessionId: String? = nil

    func matchesVerifiedSession(_ session: NativeSession) -> Bool {
        guard let verifiedUserId, let verifiedSessionId else { return false }
        return verifiedUserId.lowercased() == session.userId.lowercased()
            && verifiedSessionId.lowercased() == session.sessionId.lowercased()
    }

    func verified(by session: NativeSession) -> PendingEmailOtpAttempt {
        var result = self
        result.verifiedUserId = session.userId.lowercased()
        result.verifiedSessionId = session.sessionId.lowercased()
        return result
    }
}

struct AccessTokenClaims: Equatable, Sendable {
    var issuer: String
    var subject: String
    var sessionId: String
    var expiresAt: Date
    var assuranceLevel: String
    var hasAuthenticatedAudience: Bool
}

func parseAccessTokenClaims(_ token: String) -> AccessTokenClaims? {
    let parts = token.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3,
          let data = decodeBase64URL(String(parts[1])),
          let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let issuer = payload["iss"] as? String,
          let subject = payload["sub"] as? String,
          let sessionId = payload["session_id"] as? String,
          UUID(uuidString: subject) != nil,
          UUID(uuidString: sessionId) != nil,
          let expiresAtSeconds = (payload["exp"] as? NSNumber)?.doubleValue else { return nil }
    let audience: Bool
    if let value = payload["aud"] as? String {
        audience = value == "authenticated"
    } else if let values = payload["aud"] as? [String] {
        audience = values.contains("authenticated")
    } else {
        audience = false
    }
    return AccessTokenClaims(
        issuer: issuer.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
        subject: subject.lowercased(),
        sessionId: sessionId.lowercased(),
        expiresAt: Date(timeIntervalSince1970: expiresAtSeconds),
        assuranceLevel: payload["aal"] as? String ?? "aal1",
        hasAuthenticatedAudience: audience
    )
}

func parseNativeSessionResponse(
    _ data: Data,
    configuration: MacCloudConfiguration,
    fallbackRefreshToken: String? = nil,
    expectedUserId: String? = nil
) throws -> NativeSession {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let accessToken = object["access_token"] as? String, !accessToken.isEmpty,
          let expiresIn = (object["expires_in"] as? NSNumber)?.doubleValue,
          expiresIn >= 60, expiresIn <= 86_400,
          let claims = parseAccessTokenClaims(accessToken),
          let supabaseURL = configuration.supabaseURL else {
        throw KeychainError.invalidSession
    }
    guard let userId = (object["user"] as? [String: Any])?["id"] as? String else {
        throw KeychainError.invalidSession
    }
    guard UUID(uuidString: userId) != nil,
          claims.subject == userId.lowercased(),
          expectedUserId.map({ $0.lowercased() == userId.lowercased() }) ?? true,
          claims.issuer == supabaseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/auth/v1",
          claims.hasAuthenticatedAudience,
          claims.expiresAt > Date() else {
        throw KeychainError.invalidSession
    }
    let responseRefreshToken = (object["refresh_token"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    let refreshToken = responseRefreshToken?.isEmpty == false ? responseRefreshToken : fallbackRefreshToken
    guard let refreshToken, !refreshToken.isEmpty else { throw KeychainError.invalidSession }
    return NativeSession(
        accessToken: accessToken,
        refreshToken: refreshToken,
        expiresAt: min(Date().addingTimeInterval(expiresIn), claims.expiresAt),
        userId: userId.lowercased(),
        sessionId: claims.sessionId,
        assuranceLevel: claims.assuranceLevel
    )
}

final class KeychainMemoryBackend: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]

    func read(_ account: String) -> Data? {
        lock.lock(); defer { lock.unlock() }
        return values[account]
    }

    func write(_ data: Data, account: String) {
        lock.lock(); defer { lock.unlock() }
        values[account] = data
    }

    func delete(_ account: String) {
        lock.lock(); defer { lock.unlock() }
        values.removeValue(forKey: account)
    }
}

final class KeychainSessionStore: AuthGateway, @unchecked Sendable {
    private let service: String
    private let sessionAccount: String
    private let pendingAccount: String
    private let pendingEmailOtpAccount: String
    private let memoryBackend: KeychainMemoryBackend?
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(
        service: String = "tsurfing",
        sessionAccount: String = "session",
        pendingAccount: String = "pending-pkce",
        pendingEmailOtpAccount: String = "pending-email-otp",
        memoryBackend: KeychainMemoryBackend? = nil
    ) {
        precondition(!service.isEmpty && !sessionAccount.isEmpty && !pendingAccount.isEmpty && !pendingEmailOtpAccount.isEmpty)
        self.service = service
        self.sessionAccount = sessionAccount
        self.pendingAccount = pendingAccount
        self.pendingEmailOtpAccount = pendingEmailOtpAccount
        self.memoryBackend = memoryBackend
    }

    var isAuthenticated: Bool {
        do {
            guard try readPendingEmailOtp() == nil,
                  try readPendingRequest()?.flow.blocksSession != true,
                  let session = try read() else { return false }
            return session.expiresAt > Date().addingTimeInterval(60)
        } catch {
            return false
        }
    }

    func read() throws -> NativeSession? {
        guard let data = try readData(account: sessionAccount) else { return nil }
        guard let session = try? decoder.decode(NativeSession.self, from: data),
              UUID(uuidString: session.userId) != nil,
              UUID(uuidString: session.sessionId) != nil,
              !session.accessToken.isEmpty, !session.refreshToken.isEmpty,
              let claims = parseAccessTokenClaims(session.accessToken),
              claims.subject == session.userId,
              claims.sessionId == session.sessionId else {
            throw KeychainError.corruptSession
        }
        return session
    }

    func save(_ session: NativeSession) throws {
        guard UUID(uuidString: session.userId) != nil,
              UUID(uuidString: session.sessionId) != nil,
              !session.accessToken.isEmpty, !session.refreshToken.isEmpty,
              let claims = parseAccessTokenClaims(session.accessToken),
              claims.subject == session.userId,
              claims.sessionId == session.sessionId else { throw KeychainError.invalidSession }
        try writeData(encoder.encode(session), account: sessionAccount)
        guard try read() == session else { throw KeychainError.readBackMismatch }
    }

    func clear() throws {
        try delete(account: sessionAccount)
        guard try read() == nil else { throw KeychainError.deleteFailed(errSecInternalError) }
    }

    func clearIfAccessTokenMatches(_ accessToken: String) throws {
        if try read()?.accessToken == accessToken { try clear() }
    }

    func readPendingRequest() throws -> PendingPKCERequest? {
        guard let data = try readData(account: pendingAccount) else { return nil }
        guard let pending = try? decoder.decode(PendingPKCERequest.self, from: data),
              isValidPendingRequest(pending) else {
            throw KeychainError.corruptPendingRequest
        }
        return pending
    }

    func savePendingRequest(_ pending: PendingPKCERequest) throws {
        guard isValidPendingRequest(pending) else { throw KeychainError.corruptPendingRequest }
        try writeData(encoder.encode(pending), account: pendingAccount)
        guard try readPendingRequest() == pending else { throw KeychainError.readBackMismatch }
    }

    func clearPendingRequest() throws { try delete(account: pendingAccount) }

    func readPendingEmailOtp() throws -> PendingEmailOtpAttempt? {
        guard let data = try readData(account: pendingEmailOtpAccount) else { return nil }
        guard let pending = try? decoder.decode(PendingEmailOtpAttempt.self, from: data),
              pending.attemptToken.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil,
              pending.email == pending.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              (pending.verifiedUserId == nil && pending.verifiedSessionId == nil)
                || (pending.verifiedUserId.flatMap { UUID(uuidString: $0) } != nil
                    && pending.verifiedSessionId.flatMap { UUID(uuidString: $0) } != nil) else {
            throw KeychainError.corruptPendingEmailOtp
        }
        return pending
    }

    func savePendingEmailOtp(_ pending: PendingEmailOtpAttempt) throws {
        guard pending.attemptToken.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil,
              pending.email == pending.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              (pending.verifiedUserId == nil && pending.verifiedSessionId == nil)
                || (pending.verifiedUserId.flatMap { UUID(uuidString: $0) } != nil
                    && pending.verifiedSessionId.flatMap { UUID(uuidString: $0) } != nil) else {
            throw KeychainError.corruptPendingEmailOtp
        }
        try writeData(encoder.encode(pending), account: pendingEmailOtpAccount)
        guard try readPendingEmailOtp() == pending else { throw KeychainError.readBackMismatch }
    }

    func clearPendingEmailOtp() throws { try delete(account: pendingEmailOtpAccount) }

    func currentSession(
        configuration: MacCloudConfiguration,
        urlSession: URLSession = URLSession.shared
    ) async throws -> NativeSession {
        if try readPendingEmailOtp() != nil { throw KeychainError.activationPending }
        if try readPendingRequest()?.flow.blocksSession == true { throw KeychainError.activationPending }
        guard let current = try read() else { throw KeychainError.noSession }
        if current.expiresAt > Date().addingTimeInterval(5 * 60) { return current }
        if current.expiresAt > Date().addingTimeInterval(60) {
            do { return try await refresh(current, configuration: configuration, urlSession: urlSession) }
            catch KeychainError.transient { return current }
        }
        return try await refresh(current, configuration: configuration, urlSession: urlSession)
    }

    private func refresh(
        _ current: NativeSession,
        configuration: MacCloudConfiguration,
        urlSession: URLSession
    ) async throws -> NativeSession {
        guard configuration.isCloudConfigured,
              let supabaseURL = configuration.supabaseURL,
              let key = configuration.publishableKey,
              let url = URL(string: "/auth/v1/token?grant_type=refresh_token", relativeTo: supabaseURL)?.absoluteURL else {
            throw KeychainError.noRefreshConfig
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(key, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["refresh_token": current.refreshToken])
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await urlSession.data(for: request)
        } catch {
            throw KeychainError.transient
        }
        guard let http = response as? HTTPURLResponse else { throw KeychainError.transient }
        guard (200..<300).contains(http.statusCode) else {
            if Self.isRetryable(http.statusCode) { throw KeychainError.transient }
            try clearIfAccessTokenMatches(current.accessToken)
            throw KeychainError.revoked
        }
        let refreshed = try parseNativeSessionResponse(
            data,
            configuration: configuration,
            fallbackRefreshToken: current.refreshToken,
            expectedUserId: current.userId
        )
        try save(refreshed)
        return refreshed
    }

    private static func isRetryable(_ status: Int) -> Bool {
        status >= 500 || [408, 425, 429].contains(status)
    }

    private func isValidPendingRequest(_ pending: PendingPKCERequest) -> Bool {
        let base64URL = pending.state.range(
            of: #"^[A-Za-z0-9_-]{16,128}$"#,
            options: .regularExpression
        ) != nil
        let verifier = (43...128).contains(pending.verifier.count)
            && pending.verifier.range(
                of: #"^[A-Za-z0-9._~-]+$"#,
                options: .regularExpression
            ) != nil
        let expiry = pending.effectiveExpiresAt > pending.createdAt
            && pending.effectiveExpiresAt <= pending.createdAt.addingTimeInterval(15 * 60)
        let activationAuthority = pending.flow != .telegramActivation
            || pending.attemptToken?.range(
                of: #"^[A-Za-z0-9_-]{43}$"#,
                options: .regularExpression
            ) != nil
        let linkedUser = pending.flow != .telegramLink
            || pending.expectedUserId.flatMap(UUID.init(uuidString:)) != nil
        let hasVerifiedIdentity = pending.verifiedUserId != nil || pending.verifiedSessionId != nil
        let verifiedIdentity = !hasVerifiedIdentity || (
            pending.verifiedUserId.flatMap(UUID.init(uuidString:)) != nil
                && pending.verifiedSessionId.flatMap(UUID.init(uuidString:)) != nil
        )
        return base64URL && verifier && !pending.redirectURL.isEmpty && expiry
            && activationAuthority && linkedUser && verifiedIdentity
    }

    private func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true
        ]
    }

    private func readData(account: String) throws -> Data? {
        if let memoryBackend { return memoryBackend.read(account) }
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw KeychainError.readFailed(status) }
        return data
    }

    private func writeData(_ data: Data, account: String) throws {
        if let memoryBackend {
            memoryBackend.write(data, account: account)
            return
        }
        let query = baseQuery(account: account)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var addition = query
            addition.merge(attributes) { _, replacement in replacement }
            status = SecItemAdd(addition as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError.saveFailed(status) }
    }

    private func delete(account: String) throws {
        if let memoryBackend {
            memoryBackend.delete(account)
            return
        }
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError.deleteFailed(status) }
    }
}

enum KeychainError: Error, LocalizedError {
    case saveFailed(OSStatus)
    case readFailed(OSStatus)
    case deleteFailed(OSStatus)
    case readBackMismatch
    case corruptSession
    case corruptPendingRequest
    case corruptPendingEmailOtp
    case invalidSession
    case noSession
    case noRefreshConfig
    case transient
    case revoked
    case activationPending

    var errorDescription: String? {
        switch self {
        case .saveFailed(let status): return "The secure session could not be saved (\(status))."
        case .readFailed(let status): return "The secure session could not be read (\(status))."
        case .deleteFailed(let status): return "The secure session could not be removed (\(status))."
        case .readBackMismatch: return "Secure storage did not verify its write."
        case .corruptSession: return "Secure session data is damaged. Local tasks were not changed."
        case .corruptPendingRequest: return "The pending sign-in request is damaged. Request a new link."
        case .corruptPendingEmailOtp: return "The pending email-code request is damaged. Request a new code."
        case .invalidSession: return "The authentication response did not contain a valid Tsurfing session."
        case .noSession: return "Sign in to synchronize. Local changes remain on this Mac."
        case .noRefreshConfig: return "Session refresh is not safely configured."
        case .transient: return "Session refresh is temporarily unavailable. Local changes remain pending."
        case .revoked: return "This cloud session has expired or was revoked. Local changes remain on this Mac."
        case .activationPending: return "Account verification has not finished. Local changes remain pending."
        }
    }
}
