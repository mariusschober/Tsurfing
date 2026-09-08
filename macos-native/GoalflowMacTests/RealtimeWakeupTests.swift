import XCTest
@testable import GoalflowMac

private enum TestRealtimeSocketError: Error {
    case closed
}

private actor TestRealtimeSocketState {
    private var sent: [String] = []
    private var queued: [String] = []
    private var receiver: CheckedContinuation<String, Error>?
    private var closed = false

    func record(_ message: String) throws {
        if closed { throw TestRealtimeSocketError.closed }
        sent.append(message)
    }

    func receive() async throws -> String {
        if !queued.isEmpty { return queued.removeFirst() }
        if closed { throw TestRealtimeSocketError.closed }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }

    func push(_ message: String) {
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: message)
        } else {
            queued.append(message)
        }
    }

    func close() {
        closed = true
        if let receiver {
            self.receiver = nil
            receiver.resume(throwing: TestRealtimeSocketError.closed)
        }
    }

    func messages() -> [String] { sent }
}

private final class TestRealtimeSocket: MacRealtimeSocket, @unchecked Sendable {
    private let state = TestRealtimeSocketState()

    func send(text: String) async throws { try await state.record(text) }
    func receiveText() async throws -> String { try await state.receive() }
    func cancel() { Task { await state.close() } }
    func push(_ message: String) async { await state.push(message) }
    func messages() async -> [String] { await state.messages() }
}

private struct TestRealtimeTransport: MacRealtimeTransport {
    let socket: TestRealtimeSocket
    func connect(url: URL) throws -> any MacRealtimeSocket { socket }
}

final class RealtimeWakeupTests: XCTestCase {
    private let userId = "aaaaaaaa-1111-4111-8111-111111111111"

    func test_private_join_is_bound_to_immutable_uuid_and_has_no_write_subscription() throws {
        XCTAssertEqual(
            MacRealtimeProtocol.channelTopic(userId: userId.uppercased()),
            "tsurfing:user:\(userId)"
        )
        XCTAssertNil(MacRealtimeProtocol.channelTopic(userId: "owner@tsurfing.com"))
        XCTAssertNil(MacRealtimeProtocol.channelTopic(userId: "{\(userId)}"))

        let join = try object(MacRealtimeProtocol.join(
            reference: "1",
            userId: userId,
            accessToken: "synthetic-access-token"
        ))
        XCTAssertEqual(join["topic"] as? String, "realtime:tsurfing:user:\(userId)")
        XCTAssertEqual(join["event"] as? String, "phx_join")
        let payload = try XCTUnwrap(join["payload"] as? [String: Any])
        let config = try XCTUnwrap(payload["config"] as? [String: Any])
        XCTAssertEqual(config["private"] as? Bool, true)
        let broadcast = try XCTUnwrap(config["broadcast"] as? [String: Any])
        XCTAssertEqual(broadcast["ack"] as? Bool, false)
        XCTAssertEqual(broadcast["self"] as? Bool, false)
        XCTAssertEqual((config["postgres_changes"] as? [Any])?.count, 0)
    }

    func test_codec_accepts_only_exact_topic_and_wakeup_event() throws {
        let joined = try json([
            "topic": "realtime:tsurfing:user:\(userId)",
            "event": "phx_reply",
            "ref": "7",
            "join_ref": "7",
            "payload": ["status": "ok", "response": [:]]
        ])
        XCTAssertEqual(MacRealtimeProtocol.parse(joined, userId: userId, joinReference: "7"), .joined)

        var wake: [String: Any] = [
            "topic": "realtime:tsurfing:user:\(userId)",
            "event": "broadcast",
            "payload": [
                "event": "sync_wakeup",
                "type": "broadcast",
                "payload": ["id": "opaque"]
            ]
        ]
        XCTAssertEqual(
            MacRealtimeProtocol.parse(try json(wake), userId: userId, joinReference: "7"),
            .wakeup
        )
        wake["topic"] = "realtime:tsurfing:user:bbbbbbbb-1111-4111-8111-111111111111"
        XCTAssertEqual(
            MacRealtimeProtocol.parse(try json(wake), userId: userId, joinReference: "7"),
            .ignored
        )
        wake["topic"] = "realtime:tsurfing:user:\(userId)"
        wake["payload"] = ["event": "task_payload", "payload": ["title": "must not arrive"]]
        XCTAssertEqual(
            MacRealtimeProtocol.parse(try json(wake), userId: userId, joinReference: "7"),
            .ignored
        )
    }

    func test_adapter_catches_up_on_join_and_wakeup_then_rotates_token_without_broadcast() async throws {
        let socket = TestRealtimeSocket()
        let configuration = MacCloudConfiguration(
            apiOrigin: "https://staging.tsurfing.com",
            supabaseURL: "https://project.supabase.co",
            publishableKey: "sb_publishable_synthetic_public_key"
        )
        let client = MacRealtimeWakeupClient(
            configuration: configuration,
            transport: TestRealtimeTransport(socket: socket),
            sleeper: { _ in try await Task<Never, Never>.sleep(nanoseconds: 10_000_000_000) },
            jitterMilliseconds: { 0 }
        )
        let catchups = expectation(description: "join and wake cause cursor pulls")
        catchups.expectedFulfillmentCount = 2
        let session = NativeSession(
            accessToken: "synthetic-token-one",
            refreshToken: "synthetic-refresh",
            expiresAt: Date().addingTimeInterval(3_600),
            userId: userId,
            sessionId: "bbbbbbbb-2222-4222-8222-222222222222",
            assuranceLevel: "aal1"
        )

        await client.startOrRefresh(session: session) { catchups.fulfill() }
        let initialMessages = await socket.messages()
        let first = try XCTUnwrap(initialMessages.first)
        let join = try object(first)
        let joinReference = try XCTUnwrap(join["ref"] as? String)
        await socket.push(try json([
            "topic": join["topic"] as Any,
            "event": "phx_reply",
            "ref": joinReference,
            "join_ref": joinReference,
            "payload": ["status": "ok", "response": [:]]
        ]))
        await socket.push(try json([
            "topic": join["topic"] as Any,
            "event": "broadcast",
            "payload": ["event": "sync_wakeup", "payload": ["id": "opaque"]]
        ]))
        await fulfillment(of: [catchups], timeout: 1)

        var refreshed = session
        refreshed.accessToken = "synthetic-token-two"
        await client.startOrRefresh(session: refreshed) { catchups.fulfill() }
        let beforeStop = try await socket.messages().map(object)
        XCTAssertEqual(beforeStop.compactMap { $0["event"] as? String }, ["phx_join", "access_token"])
        XCTAssertFalse(beforeStop.contains { $0["event"] as? String == "broadcast" })

        await client.stop()
        let afterStop = try await socket.messages().map(object)
        XCTAssertEqual(afterStop.last?["event"] as? String, "phx_leave")
    }

    func test_token_refreshed_during_join_is_applied_before_first_catchup() async throws {
        let socket = TestRealtimeSocket()
        let configuration = MacCloudConfiguration(
            apiOrigin: "https://staging.tsurfing.com",
            supabaseURL: "https://project.supabase.co",
            publishableKey: "sb_publishable_synthetic_public_key"
        )
        let client = MacRealtimeWakeupClient(
            configuration: configuration,
            transport: TestRealtimeTransport(socket: socket),
            sleeper: { _ in try await Task<Never, Never>.sleep(nanoseconds: 10_000_000_000) },
            jitterMilliseconds: { 0 }
        )
        let catchup = expectation(description: "join catches up after token rotation")
        var session = NativeSession(
            accessToken: "synthetic-token-one",
            refreshToken: "synthetic-refresh",
            expiresAt: Date().addingTimeInterval(3_600),
            userId: userId,
            sessionId: "bbbbbbbb-2222-4222-8222-222222222222",
            assuranceLevel: "aal1"
        )

        await client.startOrRefresh(session: session) { catchup.fulfill() }
        let initialMessages = await socket.messages()
        let join = try object(XCTUnwrap(initialMessages.first))
        let joinReference = try XCTUnwrap(join["ref"] as? String)
        session.accessToken = "synthetic-token-two"
        await client.startOrRefresh(session: session) { catchup.fulfill() }
        let messagesBeforeJoin = await socket.messages()
        XCTAssertEqual(messagesBeforeJoin.count, 1)

        await socket.push(try json([
            "topic": join["topic"] as Any,
            "event": "phx_reply",
            "ref": joinReference,
            "join_ref": joinReference,
            "payload": ["status": "ok", "response": [:]]
        ]))
        await fulfillment(of: [catchup], timeout: 1)

        let wireMessages = await socket.messages()
        let messages = try wireMessages.map(object)
        XCTAssertEqual(messages.compactMap { $0["event"] as? String }, ["phx_join", "access_token"])
        let update = try XCTUnwrap(messages.last?["payload"] as? [String: Any])
        XCTAssertEqual(update["access_token"] as? String, "synthetic-token-two")
        await client.stop()
    }

    func test_endpoint_backoff_heartbeat_and_foreground_fallback_are_bounded() throws {
        let endpoint = try MacRealtimeProtocol.socketURL(
            supabaseURL: URL(string: "https://project.supabase.co")!,
            publishableKey: "sb_publishable_synthetic_public_key"
        )
        XCTAssertEqual(endpoint.scheme, "wss")
        XCTAssertEqual(endpoint.path, "/realtime/v1/websocket")
        XCTAssertTrue(endpoint.absoluteString.contains("vsn=1.0.0"))
        XCTAssertThrowsError(try MacRealtimeProtocol.socketURL(
            supabaseURL: URL(string: "https://project.supabase.co")!,
            publishableKey: "sb_secret_must_never_enter_a_client"
        ))
        XCTAssertEqual(macRealtimeReconnectDelayNanoseconds(attempt: 0, jitterMilliseconds: 0), 500_000_000)
        XCTAssertEqual(macRealtimeReconnectDelayNanoseconds(attempt: 1, jitterMilliseconds: 250), 1_250_000_000)
        XCTAssertEqual(macRealtimeReconnectDelayNanoseconds(attempt: 20, jitterMilliseconds: 250), 30_000_000_000)
        XCTAssertEqual(macForegroundSyncIntervalNanoseconds, 30_000_000_000)
        XCTAssertLessThan(macRealtimeHeartbeatIntervalNanoseconds, 25_000_000_000)
    }

    private func object(_ message: String) throws -> [String: Any] {
        let data = try XCTUnwrap(message.data(using: .utf8))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func json(_ object: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return try XCTUnwrap(String(data: data, encoding: .utf8))
    }
}
