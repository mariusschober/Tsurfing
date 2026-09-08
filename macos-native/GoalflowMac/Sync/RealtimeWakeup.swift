import Foundation
import Network

let macForegroundSyncIntervalNanoseconds: UInt64 = 30_000_000_000
let macRealtimeHeartbeatIntervalNanoseconds: UInt64 = 20_000_000_000
private let macRealtimeMaximumMessageBytes = 64 * 1024

enum MacRealtimeEvent: Equatable {
    case joined
    case wakeup
    case disconnected
    case ignored
    case malformed
}

enum MacRealtimeError: Error {
    case invalidConfiguration
    case binaryMessage
}

enum MacRealtimeProtocol {
    static func channelTopic(userId: String) -> String? {
        guard userId.range(
            of: #"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"#,
            options: .regularExpression
        ) != nil else { return nil }
        return "tsurfing:user:\(userId.lowercased())"
    }

    static func wireTopic(userId: String) -> String? {
        channelTopic(userId: userId).map { "realtime:\($0)" }
    }

    static func socketURL(supabaseURL: URL, publishableKey: String) throws -> URL {
        guard supabaseURL.scheme?.lowercased() == "https",
              supabaseURL.user == nil,
              supabaseURL.password == nil,
              supabaseURL.query == nil,
              supabaseURL.fragment == nil,
              isPublicProjectKey(publishableKey),
              var components = URLComponents(url: supabaseURL, resolvingAgainstBaseURL: false) else {
            throw MacRealtimeError.invalidConfiguration
        }
        components.scheme = "wss"
        components.path = "/realtime/v1/websocket"
        components.queryItems = [
            URLQueryItem(name: "apikey", value: publishableKey),
            URLQueryItem(name: "vsn", value: "1.0.0")
        ]
        guard let url = components.url else { throw MacRealtimeError.invalidConfiguration }
        return url
    }

    static func join(reference: String, userId: String, accessToken: String) throws -> String {
        guard let topic = wireTopic(userId: userId), !accessToken.isEmpty else {
            throw MacRealtimeError.invalidConfiguration
        }
        return try envelope(
            topic: topic,
            event: "phx_join",
            payload: [
                "config": [
                    "broadcast": ["ack": false, "self": false],
                    "presence": ["enabled": false],
                    "postgres_changes": [],
                    "private": true
                ],
                "access_token": accessToken
            ],
            reference: reference,
            joinReference: reference
        )
    }

    static func heartbeat(reference: String) throws -> String {
        try envelope(
            topic: "phoenix",
            event: "heartbeat",
            payload: [:],
            reference: reference,
            joinReference: nil
        )
    }

    static func accessToken(
        joinReference: String,
        reference: String,
        userId: String,
        token: String
    ) throws -> String {
        guard let topic = wireTopic(userId: userId), !token.isEmpty else {
            throw MacRealtimeError.invalidConfiguration
        }
        return try envelope(
            topic: topic,
            event: "access_token",
            payload: ["access_token": token],
            reference: reference,
            joinReference: joinReference
        )
    }

    static func leave(joinReference: String, reference: String, userId: String) throws -> String {
        guard let topic = wireTopic(userId: userId) else {
            throw MacRealtimeError.invalidConfiguration
        }
        return try envelope(
            topic: topic,
            event: "phx_leave",
            payload: [:],
            reference: reference,
            joinReference: joinReference
        )
    }

    static func parse(_ message: String, userId: String, joinReference: String) -> MacRealtimeEvent {
        guard let data = message.data(using: .utf8), data.count <= macRealtimeMaximumMessageBytes,
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let expectedTopic = wireTopic(userId: userId),
              let topic = root["topic"] as? String,
              let event = root["event"] as? String else { return .malformed }
        guard topic == expectedTopic else { return .ignored }
        switch event {
        case "phx_reply":
            guard root["ref"] as? String == joinReference else { return .ignored }
            guard let payload = root["payload"] as? [String: Any] else { return .malformed }
            return payload["status"] as? String == "ok" ? .joined : .disconnected
        case "broadcast":
            guard let payload = root["payload"] as? [String: Any] else { return .malformed }
            return payload["event"] as? String == "sync_wakeup"
                && payload["payload"] is [String: Any] ? .wakeup : .ignored
        case "phx_close", "phx_error":
            return .disconnected
        default:
            return .ignored
        }
    }

    private static func envelope(
        topic: String,
        event: String,
        payload: [String: Any],
        reference: String,
        joinReference: String?
    ) throws -> String {
        let object: [String: Any] = [
            "topic": topic,
            "event": event,
            "payload": payload,
            "ref": reference,
            "join_ref": joinReference ?? NSNull()
        ]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard let value = String(data: data, encoding: .utf8) else {
            throw MacRealtimeError.invalidConfiguration
        }
        return value
    }

    private static func isPublicProjectKey(_ key: String) -> Bool {
        let lower = key.lowercased()
        guard !lower.hasPrefix("sb_secret_"), !lower.contains("service_role") else { return false }
        if key.hasPrefix("sb_publishable_") { return key.count >= 24 }
        let parts = key.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3,
              let data = decodeBase64URL(String(parts[1])),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return false
        }
        return object["role"] as? String == "anon"
    }
}

func macRealtimeReconnectDelayNanoseconds(attempt: Int, jitterMilliseconds: UInt64) -> UInt64 {
    let exponent = min(max(attempt, 0), 6)
    let baseMilliseconds = min(UInt64(500) * (UInt64(1) << UInt64(exponent)), UInt64(30_000))
    let milliseconds = min(baseMilliseconds + min(jitterMilliseconds, 250), UInt64(30_000))
    return milliseconds * 1_000_000
}

protocol MacRealtimeSocket: AnyObject, Sendable {
    func send(text: String) async throws
    func receiveText() async throws -> String
    func cancel()
}

protocol MacRealtimeTransport: Sendable {
    func connect(url: URL) throws -> any MacRealtimeSocket
}

private final class URLSessionMacRealtimeSocket: MacRealtimeSocket, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    init(task: URLSessionWebSocketTask) {
        self.task = task
    }

    func send(text: String) async throws {
        try await task.send(.string(text))
    }

    func receiveText() async throws -> String {
        switch try await task.receive() {
        case .string(let value): return value
        case .data: throw MacRealtimeError.binaryMessage
        @unknown default: throw MacRealtimeError.binaryMessage
        }
    }

    func cancel() {
        task.cancel(with: .normalClosure, reason: nil)
    }
}

final class URLSessionMacRealtimeTransport: MacRealtimeTransport, @unchecked Sendable {
    private let session: URLSession

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 20
            configuration.timeoutIntervalForResource = 86_400
            configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            self.session = URLSession(configuration: configuration)
        }
    }

    func connect(url: URL) throws -> any MacRealtimeSocket {
        var request = URLRequest(url: url)
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        let task = session.webSocketTask(with: request)
        task.resume()
        return URLSessionMacRealtimeSocket(task: task)
    }
}

actor MacRealtimeWakeupClient {
    typealias Sleeper = @Sendable (UInt64) async throws -> Void

    private let configuration: MacCloudConfiguration
    private let transport: any MacRealtimeTransport
    private let sleeper: Sleeper
    private let jitterMilliseconds: @Sendable () -> UInt64
    private var active = false
    private var generation = 0
    private var session: NativeSession?
    private var wake: @Sendable () -> Void = {}
    private var socket: (any MacRealtimeSocket)?
    private var socketAccessToken: String?
    private var joined = false
    private var joinReference = ""
    private var reference: UInt64 = 0
    private var reconnectAttempt = 0
    private var receiveTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?

    init(
        configuration: MacCloudConfiguration = .current,
        transport: any MacRealtimeTransport = URLSessionMacRealtimeTransport(),
        sleeper: @escaping Sleeper = { try await Task<Never, Never>.sleep(nanoseconds: $0) },
        jitterMilliseconds: @escaping @Sendable () -> UInt64 = { UInt64.random(in: 0...250) }
    ) {
        self.configuration = configuration
        self.transport = transport
        self.sleeper = sleeper
        self.jitterMilliseconds = jitterMilliseconds
    }

    func startOrRefresh(session nextSession: NativeSession, onWake: @escaping @Sendable () -> Void) async {
        guard let normalizedUserId = MacRealtimeProtocol.channelTopic(userId: nextSession.userId)?
            .replacingOccurrences(of: "tsurfing:user:", with: ""),
              nextSession.expiresAt > Date().addingTimeInterval(60),
              configuration.isCloudConfigured else {
            await stop()
            return
        }
        var normalized = nextSession
        normalized.userId = normalizedUserId

        if active, session?.userId.lowercased() == normalizedUserId {
            let tokenChanged = socketAccessToken != normalized.accessToken
            let targetGeneration = generation
            session = normalized
            wake = onWake
            if tokenChanged, joined, let socket {
                do {
                    try await socket.send(text: MacRealtimeProtocol.accessToken(
                        joinReference: joinReference,
                        reference: nextReference(),
                        userId: normalizedUserId,
                        token: normalized.accessToken
                    ))
                    guard active, generation == targetGeneration, isCurrent(socket) else { return }
                    socketAccessToken = normalized.accessToken
                } catch {
                    handleDisconnected(source: socket, generation: targetGeneration)
                }
            } else if socket == nil, reconnectTask == nil {
                await connect(generation: generation)
            }
            return
        }
        generation += 1
        let targetGeneration = generation
        let closing = detachCurrent(sendLeave: true)
        active = true
        session = normalized
        wake = onWake
        reconnectAttempt = 0
        await finishClosing(closing)
        guard active, generation == targetGeneration, session?.userId == normalizedUserId else { return }
        await connect(generation: targetGeneration)
    }

    func stop() async {
        active = false
        generation += 1
        let closing = detachCurrent(sendLeave: true)
        session = nil
        await finishClosing(closing)
    }

    private func connect(generation targetGeneration: Int) async {
        guard active, generation == targetGeneration,
              let current = session,
              let supabaseURL = configuration.supabaseURL,
              let key = configuration.publishableKey else { return }
        do {
            let endpoint = try MacRealtimeProtocol.socketURL(
                supabaseURL: supabaseURL,
                publishableKey: key
            )
            let candidate = try transport.connect(url: endpoint)
            guard active, generation == targetGeneration else {
                candidate.cancel()
                return
            }
            socket = candidate
            socketAccessToken = current.accessToken
            joined = false
            joinReference = nextReference()
            try await candidate.send(text: MacRealtimeProtocol.join(
                reference: joinReference,
                userId: current.userId,
                accessToken: current.accessToken
            ))
            guard active, generation == targetGeneration, isCurrent(candidate) else {
                candidate.cancel()
                return
            }
            let expectedJoinReference = joinReference
            receiveTask = Task { [weak self] in
                await self?.receiveLoop(
                    source: candidate,
                    generation: targetGeneration,
                    joinReference: expectedJoinReference
                )
            }
        } catch {
            if let socket { handleDisconnected(source: socket, generation: targetGeneration) }
            else { scheduleReconnect(generation: targetGeneration) }
        }
    }

    private func receiveLoop(
        source: any MacRealtimeSocket,
        generation targetGeneration: Int,
        joinReference expectedJoinReference: String
    ) async {
        do {
            while !Task.isCancelled {
                let message = try await source.receiveText()
                guard active, generation == targetGeneration, isCurrent(source),
                      let userId = session?.userId else { return }
                switch MacRealtimeProtocol.parse(
                    message,
                    userId: userId,
                    joinReference: expectedJoinReference
                ) {
                case .joined:
                    guard !joined else { continue }
                    joined = true
                    if let current = session, socketAccessToken != current.accessToken {
                        do {
                            try await source.send(text: MacRealtimeProtocol.accessToken(
                                joinReference: expectedJoinReference,
                                reference: nextReference(),
                                userId: current.userId,
                                token: current.accessToken
                            ))
                            guard active, generation == targetGeneration, isCurrent(source) else { return }
                            socketAccessToken = current.accessToken
                        } catch {
                            handleDisconnected(source: source, generation: targetGeneration)
                            return
                        }
                    }
                    reconnectAttempt = 0
                    startHeartbeat(source: source, generation: targetGeneration)
                    wake()
                case .wakeup:
                    guard joined else { continue }
                    wake()
                case .disconnected, .malformed:
                    handleDisconnected(source: source, generation: targetGeneration)
                    return
                case .ignored:
                    continue
                }
            }
        } catch {
            handleDisconnected(source: source, generation: targetGeneration)
        }
    }

    private func startHeartbeat(source: any MacRealtimeSocket, generation targetGeneration: Int) {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self, sleeper] in
            while !Task.isCancelled {
                do { try await sleeper(macRealtimeHeartbeatIntervalNanoseconds) }
                catch { return }
                guard let self else { return }
                await self.sendHeartbeat(source: source, generation: targetGeneration)
            }
        }
    }

    private func sendHeartbeat(source: any MacRealtimeSocket, generation targetGeneration: Int) async {
        guard active, generation == targetGeneration, joined, isCurrent(source) else { return }
        do {
            try await source.send(text: MacRealtimeProtocol.heartbeat(reference: nextReference()))
        } catch {
            handleDisconnected(source: source, generation: targetGeneration)
        }
    }

    private func handleDisconnected(source: any MacRealtimeSocket, generation targetGeneration: Int) {
        guard active, generation == targetGeneration, isCurrent(source) else { return }
        socket = nil
        socketAccessToken = nil
        joined = false
        receiveTask?.cancel()
        receiveTask = nil
        heartbeatTask?.cancel()
        heartbeatTask = nil
        source.cancel()
        scheduleReconnect(generation: targetGeneration)
    }

    private func scheduleReconnect(generation targetGeneration: Int) {
        guard active, generation == targetGeneration, reconnectTask == nil else { return }
        let delay = macRealtimeReconnectDelayNanoseconds(
            attempt: reconnectAttempt,
            jitterMilliseconds: jitterMilliseconds()
        )
        reconnectAttempt += 1
        reconnectTask = Task { [weak self, sleeper] in
            do { try await sleeper(delay) }
            catch { return }
            await self?.retryConnect(generation: targetGeneration)
        }
    }

    private func retryConnect(generation targetGeneration: Int) async {
        reconnectTask = nil
        guard active, generation == targetGeneration else { return }
        await connect(generation: targetGeneration)
    }

    private func detachCurrent(
        sendLeave: Bool
    ) -> (target: (any MacRealtimeSocket)?, leaveMessage: String?) {
        let target = socket
        let leaveMessage: String?
        if sendLeave, joined, let userId = session?.userId, !joinReference.isEmpty {
            leaveMessage = try? MacRealtimeProtocol.leave(
                joinReference: joinReference,
                reference: nextReference(),
                userId: userId
            )
        } else {
            leaveMessage = nil
        }
        socket = nil
        socketAccessToken = nil
        joined = false
        joinReference = ""
        receiveTask?.cancel()
        receiveTask = nil
        heartbeatTask?.cancel()
        heartbeatTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        return (target, leaveMessage)
    }

    private func finishClosing(
        _ closing: (target: (any MacRealtimeSocket)?, leaveMessage: String?)
    ) async {
        if let leaveMessage = closing.leaveMessage, let target = closing.target {
            try? await target.send(text: leaveMessage)
        }
        closing.target?.cancel()
    }

    private func isCurrent(_ candidate: any MacRealtimeSocket) -> Bool {
        guard let socket else { return false }
        return socket === candidate
    }

    private func nextReference() -> String {
        reference = reference == UInt64.max ? 1 : reference + 1
        return String(reference)
    }
}

@MainActor
final class MacForegroundSyncCoordinator {
    private let configuration: MacCloudConfiguration
    private let keychain: KeychainSessionStore
    private let realtime: MacRealtimeWakeupClient
    private let canSynchronize: @MainActor @Sendable () -> Bool
    private let synchronize: @MainActor @Sendable () async -> Void
    private let monitorQueue = DispatchQueue(label: "com.mariusschober.tsurfing.realtime-network")
    private var monitor: NWPathMonitor?
    private var active = false
    private var online = true
    private var pending = false
    private var syncTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?

    init(
        configuration: MacCloudConfiguration = .current,
        keychain: KeychainSessionStore = KeychainSessionStore(),
        realtime: MacRealtimeWakeupClient? = nil,
        canSynchronize: @escaping @MainActor @Sendable () -> Bool,
        synchronize: @escaping @MainActor @Sendable () async -> Void
    ) {
        self.configuration = configuration
        self.keychain = keychain
        self.realtime = realtime ?? MacRealtimeWakeupClient(configuration: configuration)
        self.canSynchronize = canSynchronize
        self.synchronize = synchronize
    }

    func start() {
        guard configuration.isCloudConfigured, !active else {
            if active { requestSync() }
            return
        }
        active = true
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in self?.networkChanged(online: path.status == .satisfied) }
        }
        self.monitor = monitor
        monitor.start(queue: monitorQueue)
        pollTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do { try await Task<Never, Never>.sleep(nanoseconds: macForegroundSyncIntervalNanoseconds) }
                catch { return }
                self?.requestSync()
            }
        }
        requestSync()
    }

    func requestSync() {
        guard active, online else { return }
        pending = true
        guard syncTask == nil else { return }
        syncTask = Task { @MainActor [weak self] in
            guard let self else { return }
            while self.active, self.online, self.pending {
                self.pending = false
                await self.synchronizeAndSubscribe()
            }
            self.syncTask = nil
            if self.pending { self.requestSync() }
        }
    }

    func sessionChanged() {
        if canSynchronize() { requestSync() }
        else { Task { await realtime.stop() } }
    }

    func applicationDidBecomeActive() {
        requestSync()
    }

    func shutdown() {
        active = false
        pending = false
        monitor?.cancel()
        monitor = nil
        pollTask?.cancel()
        pollTask = nil
        syncTask?.cancel()
        syncTask = nil
        Task { await realtime.stop() }
    }

    private func networkChanged(online: Bool) {
        self.online = online
        if online { requestSync() }
        else { Task { await realtime.stop() } }
    }

    private func synchronizeAndSubscribe() async {
        guard canSynchronize() else {
            await realtime.stop()
            return
        }
        do {
            let session = try await keychain.currentSession(configuration: configuration)
            await realtime.startOrRefresh(session: session) { [weak self] in
                Task { @MainActor in self?.requestSync() }
            }
            await synchronize()
        } catch KeychainError.noSession, KeychainError.activationPending {
            await realtime.stop()
        } catch KeychainError.revoked {
            await realtime.stop()
            NotificationCenter.default.post(name: .authDidChange, object: nil)
        } catch {
            // The durable local outbox and cursor remain authoritative. A
            // wake, reconnect, focus, network recovery, or fallback retries.
        }
    }
}

extension Notification.Name {
    static let syncMutationCommitted = Notification.Name("goalflow.syncMutationCommitted")
}
