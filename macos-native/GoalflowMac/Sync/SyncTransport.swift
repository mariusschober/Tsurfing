import Foundation

struct MacCloudConfiguration: Equatable, Sendable {
    static let authRedirectURL = "tsurfing://auth/callback"

    let apiOrigin: URL?
    let supabaseURL: URL?
    let publishableKey: String?
    let environment: String
    let problem: String?
    let telegramEnabled: Bool
    let telegramProviderId: String

    static var current: MacCloudConfiguration {
        MacCloudConfiguration(info: Bundle.main.infoDictionary ?? [:])
    }

    init(info: [String: Any], allowInsecureLoopback: Bool = false) {
        self.init(
            apiOrigin: Self.clean(info["API_ORIGIN"] as? String),
            supabaseURL: Self.clean(info["SUPABASE_URL"] as? String),
            publishableKey: Self.clean(
                (info["SUPABASE_PUBLISHABLE_KEY"] as? String)
                    ?? (info["SUPABASE_ANON_KEY"] as? String)
            ),
            environment: Self.clean(info["GOALFLOW_ENVIRONMENT"] as? String) ?? "production",
            telegramEnabled: Self.clean(info["TELEGRAM_ENABLED"] as? String)?.lowercased() == "true",
            telegramProviderId: Self.clean(info["TELEGRAM_OIDC_PROVIDER_ID"] as? String) ?? "custom:telegram",
            allowInsecureLoopback: allowInsecureLoopback
        )
    }

    init(
        apiOrigin: String?,
        supabaseURL: String?,
        publishableKey: String?,
        environment: String = "production",
        telegramEnabled: Bool = false,
        telegramProviderId: String = "custom:telegram",
        allowInsecureLoopback: Bool = false
    ) {
        let api = Self.safeOrigin(apiOrigin, allowInsecureLoopback: allowInsecureLoopback)
        let supabase = Self.safeOrigin(supabaseURL, allowInsecureLoopback: allowInsecureLoopback)
        let key = Self.clean(publishableKey)
        self.apiOrigin = api
        self.supabaseURL = supabase
        self.publishableKey = key
        self.environment = environment
        self.telegramEnabled = telegramEnabled
        self.telegramProviderId = telegramProviderId

        if apiOrigin == nil && supabaseURL == nil && publishableKey == nil {
            self.problem = "Cloud sync is not configured for this build. Local changes remain on this Mac."
        } else if api == nil || supabase == nil || key == nil {
            self.problem = "Cloud settings are incomplete or use an unsafe origin. Local changes remain pending."
        } else if !Self.isSafePublicKey(key!) {
            self.problem = "The configured Supabase key is not a client publishable key. Cloud access is disabled."
        } else {
            self.problem = nil
        }
    }

    var isCloudConfigured: Bool { problem == nil }
    var isTelegramConfigured: Bool {
        isCloudConfigured
            && telegramEnabled
            && telegramProviderId.range(
                of: #"^custom:[a-z0-9:-]+$"#,
                options: .regularExpression
            ) != nil
    }

    private static func clean(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !trimmed.isEmpty, !trimmed.contains("$("),
              !trimmed.lowercased().contains("example") else { return nil }
        return trimmed
    }

    private static func safeOrigin(_ value: String?, allowInsecureLoopback: Bool) -> URL? {
        guard let value = clean(value), var components = URLComponents(string: value),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil else { return nil }
        let secure = components.scheme?.lowercased() == "https"
        let loopback = allowInsecureLoopback
            && components.scheme?.lowercased() == "http"
            && (host == "127.0.0.1" || host == "localhost")
        guard secure || loopback else { return nil }
        guard components.path.isEmpty || components.path == "/" else { return nil }
        components.path = ""
        return components.url
    }

    private static func isSafePublicKey(_ key: String) -> Bool {
        let lower = key.lowercased()
        if lower.hasPrefix("sb_secret_") || lower.contains("service_role") { return false }
        if key.hasPrefix("sb_publishable_") { return key.count >= 24 }
        let parts = key.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3,
              let payload = decodeBase64URL(String(parts[1])),
              let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else { return false }
        return object["role"] as? String == "anon"
    }
}

func decodeBase64URL(_ value: String) -> Data? {
    var encoded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
    return Data(base64Encoded: encoded)
}

protocol SyncTransport: Sendable {
    func currentUserId() async throws -> String
    func request(path: String, method: String, headers: [String: String], body: Data?) async throws -> (Data, HTTPURLResponse)
}

enum CloudTransportError: Error, LocalizedError {
    case notConfigured(String)
    case invalidRequest
    case authenticationExpired
    case sessionChanged

    var errorDescription: String? {
        switch self {
        case .notConfigured(let message): return message
        case .invalidRequest: return "The cloud request was invalid. Local changes remain pending."
        case .authenticationExpired: return "The cloud session is no longer valid. Local changes remain pending."
        case .sessionChanged: return "The account changed during synchronization. Local changes remain pending."
        }
    }
}

final class URLSessionSyncTransport: SyncTransport, @unchecked Sendable {
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
            sessionConfiguration.timeoutIntervalForRequest = 20
            sessionConfiguration.timeoutIntervalForResource = 25
            sessionConfiguration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            self.urlSession = URLSession(configuration: sessionConfiguration)
        }
    }

    func currentUserId() async throws -> String {
        try await keychain.currentSession(configuration: configuration, urlSession: urlSession).userId
    }

    func request(
        path: String,
        method: String,
        headers: [String: String] = [:],
        body: Data?
    ) async throws -> (Data, HTTPURLResponse) {
        guard configuration.isCloudConfigured,
              let origin = configuration.apiOrigin else {
            throw CloudTransportError.notConfigured(configuration.problem ?? "Cloud sync is not configured.")
        }
        guard path.hasPrefix("/api/v1/"), !path.contains("://"),
              let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              url.scheme == origin.scheme, url.host == origin.host else {
            throw CloudTransportError.invalidRequest
        }
        let normalizedMethod = method.uppercased()
        guard ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(normalizedMethod),
              !headers.keys.contains(where: {
                  ["authorization", "host", "apikey", "cookie"].contains($0.lowercased())
              }) else {
            throw CloudTransportError.invalidRequest
        }
        let session = try await keychain.currentSession(configuration: configuration, urlSession: urlSession)
        var request = URLRequest(url: url)
        request.httpMethod = normalizedMethod
        request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        request.httpBody = body

        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw CloudTransportError.invalidRequest }
        let current = try keychain.read()
        guard current?.userId == session.userId else { throw CloudTransportError.sessionChanged }
        if http.statusCode == 401 || http.statusCode == 403 {
            try keychain.clearIfAccessTokenMatches(session.accessToken)
            NotificationCenter.default.post(name: .authDidChange, object: nil)
            throw CloudTransportError.authenticationExpired
        }
        return (data, http)
    }
}

final class MockSyncTransport: SyncTransport, @unchecked Sendable {
    static let defaultUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    var userId = defaultUserId
    var pushHandler: ((Data) async throws -> (Data, HTTPURLResponse))?
    var pullHandler: ((String) async throws -> (Data, HTTPURLResponse))?
    var conflictHandler: ((String, String, Data?) async throws -> (Data, HTTPURLResponse))?
    func currentUserId() async throws -> String { userId }
    func request(path: String, method: String, headers: [String: String], body: Data?) async throws -> (Data, HTTPURLResponse) {
        if path.hasPrefix("/api/v1/sync/push") {
            if let handler = pushHandler, let body { return try await handler(body) }
        }
        if path.hasPrefix("/api/v1/sync/pull") {
            if let handler = pullHandler { return try await handler(path) }
        }
        if path.hasPrefix("/api/v1/sync/conflicts") {
            if let handler = conflictHandler { return try await handler(path, method, body) }
            let data = try JSONSerialization.data(withJSONObject: ["conflicts": []])
            let response = HTTPURLResponse(url: URL(string: "https://example.com")!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (data, response)
        }
        throw SyncError.validation("Mock no handler for \(path)")
    }
}
