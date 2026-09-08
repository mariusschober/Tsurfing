import XCTest
@testable import GoalflowMac

final class CausalJournalTests: XCTestCase {
    private func isolated() throws -> (URL, UserDefaults, String) {
        let suite = "goalflow.causal.journal.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock {
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: dir)
        }
        return (dir, defaults, suite)
    }

    private func tracking(date: String = "2026-09-08") -> [String: Any] {
        ["date": date, "planViewCount": 27, "dailyPostponeCount": 3, "unknown": ["retained": true]]
    }

    func testPreparePreservesTrackingVerbatimAndIsIdempotent() throws {
        let (dir, defaults, _) = try isolated()
        let id = UUID().uuidString.lowercased()
        let store = try CausalJournalStore(accountId: id, directory: dir, defaults: defaults)
        XCTAssertNil(try store.load())
        let first = try store.prepare(tracking: tracking())
        XCTAssertEqual(first.schemaVersion, 1)
        XCTAssertEqual(first.accountId, id)
        XCTAssertEqual(first.generation, 0)
        XCTAssertTrue(first.trackingPresent)
        XCTAssertEqual(stableJson(first.trackingValue?.value), stableJson(tracking()))
        XCTAssertEqual(stableJson(first.cutoverTracking?.value), stableJson(tracking()))
        XCTAssertTrue(first.focusAdmissions.isEmpty && first.focusOutbox.isEmpty)
        // Re-preparation validates and returns the retained journal unchanged,
        // even if the caller now reports different tracking.
        var changed = tracking()
        changed["planViewCount"] = 99
        XCTAssertEqual(try store.prepare(tracking: changed), first)
        XCTAssertEqual(try store.load(), first)
    }

    func testPrepareRecordsAbsenceWithoutInventingDefaults() throws {
        let (dir, defaults, _) = try isolated()
        let id = UUID().uuidString.lowercased()
        let store = try CausalJournalStore(accountId: id, directory: dir, defaults: defaults)
        let state = try store.prepare(tracking: nil)
        XCTAssertFalse(state.trackingPresent)
        XCTAssertNil(state.trackingValue?.value)
        XCTAssertNil(state.cutoverTracking?.value)
        XCTAssertEqual(try store.load(), state)
    }

    func testInvalidAccountPreparesNothing() throws {
        let (dir, defaults, _) = try isolated()
        XCTAssertThrowsError(try CausalJournalStore(accountId: "not-a-uuid", directory: dir, defaults: defaults))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path).count, 0)
    }

    func testMissingMirrorHealsFromFileAndMissingFileHealsFromMirror() throws {
        let (dir, defaults, suite) = try isolated()
        let id = UUID().uuidString.lowercased()
        let prepared = try CausalJournalStore(accountId: id, directory: dir, defaults: defaults).prepare(tracking: tracking())
        let file = try CausalJournalStore(accountId: id, directory: dir, defaults: defaults).fileURL
        try FileManager.default.removeItem(at: file)
        XCTAssertEqual(try CausalJournalStore(accountId: id, directory: dir, defaults: defaults).load(), prepared)
        defaults.removeObject(forKey: "goalflow.causal.\(id)")
        XCTAssertEqual(try CausalJournalStore(accountId: id, directory: dir, defaults: defaults).load(), prepared)
        _ = suite
    }

    func testDamagedJournalFailsClosedWithoutDeletingEvidence() throws {
        let (dir, defaults, _) = try isolated()
        let id = UUID().uuidString.lowercased()
        let store = try CausalJournalStore(accountId: id, directory: dir, defaults: defaults)
        _ = try store.prepare(tracking: tracking())
        let file = store.fileURL
        try "not json".write(to: file, atomically: true, encoding: .utf8)
        defaults.set("not json".data(using: .utf8)!, forKey: "goalflow.causal.\(id)")
        XCTAssertThrowsError(try store.load())
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        XCTAssertNotNil(defaults.data(forKey: "goalflow.causal.\(id)"))
    }

    func testTamperedTrackingOrFocusFailsValidation() throws {
        let (dir, defaults, _) = try isolated()
        let id = UUID().uuidString.lowercased()
        let store = try CausalJournalStore(accountId: id, directory: dir, defaults: defaults)
        var state = try store.prepare(tracking: tracking())
        state.trackingValue = AnyCodable(["date": "2026-09-08", "planViewCount": 28, "dailyPostponeCount": 3])
        XCTAssertThrowsError(try CausalJournalStore.validate(state))
        state = try XCTUnwrap(store.load())
        var focus = Dictionary(uniqueKeysWithValues: state.focus.map { ($0.key, $0.value.value ?? NSNull()) })
        focus["sessions"] = ["forged": true]
        state.focus = Dictionary(uniqueKeysWithValues: focus.map { ($0.key, AnyCodable($0.value)) })
        XCTAssertThrowsError(try CausalJournalStore.validate(state))
        state.generation = -1
        XCTAssertThrowsError(try CausalJournalStore.validate(state))
        // The persisted journal is untouched by failed validations.
        XCTAssertEqual(try store.load()?.generation, 0)
    }

    func testPrepareWithActiveFocusSessionRetainsBaseline() throws {
        let (dir, defaults, _) = try isolated()
        let id = UUID().uuidString.lowercased()
        let session = ["schemaVersion": 1, "sessionId": "11111111-1111-4111-8111-111111111111", "taskId": "task",
            "phase": "active", "plannedDurationSeconds": 600, "startedAt": "2026-09-08T10:00:00.000Z",
            "updatedAt": "2026-09-08T10:00:00.000Z", "elapsedSeconds": 0, "pausedAt": NSNull(), "endedAt": NSNull()] as [String: Any]
        var payload = tracking()
        payload["focusSession"] = session
        let state = try CausalJournalStore(accountId: id, directory: dir, defaults: defaults).prepare(tracking: payload)
        let journal = Dictionary(uniqueKeysWithValues: state.focus.map { ($0.key, $0.value.value ?? NSNull()) })
        XCTAssertEqual((journal["sessions"] as? [String: Any])?.keys.sorted(), ["11111111-1111-4111-8111-111111111111"])
        XCTAssertEqual(journal["currentSessionId"] as? String, "11111111-1111-4111-8111-111111111111")
    }
}

final class CausalFocusAdmissionTests: XCTestCase {
    private func isolated() throws -> (URL, UserDefaults) {
        let suite = "goalflow.causal.admit.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock {
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: dir)
        }
        return (dir, defaults)
    }

    private func store() throws -> (CausalJournalStore, String) {
        let (dir, defaults) = try isolated()
        let id = UUID().uuidString.lowercased()
        let store = try CausalJournalStore(accountId: id, directory: dir, defaults: defaults)
        _ = try store.prepare(tracking: ["date": "2026-09-08", "planViewCount": 27, "dailyPostponeCount": 3])
        return (store, id)
    }

    private func intent(session: String, kind: String, task: String = "task", duration: Int? = nil, id: String = UUID().uuidString.lowercased()) -> [String: Any] {
        ["actionId": id, "kind": kind, "sessionId": session, "taskId": task,
         "capturedAt": "2026-09-08T10:00:00.000Z", "durationSeconds": duration as Any? ?? NSNull(),
         "actorId": "test"]
    }

    func testStartPauseExtendStopComposeWithDuplicatesAndStaleRejection() throws {
        let (store, _) = try store()
        let session = UUID().uuidString.lowercased()
        let started = try store.admitFocus(intent(session: session, kind: "start", duration: 600)) { _ in true }
        XCTAssertFalse(started.duplicate)
        XCTAssertEqual((started.outcome["accepted"] as? Bool), true)
        XCTAssertEqual(((started.tracking["focusSession"] as? [String: Any])?["plannedDurationSeconds"] as? Int), 600)
        XCTAssertEqual(started.generation, 1)
        let extended = try store.admitFocus(intent(session: session, kind: "extend", duration: 300)) { _ in true }
        XCTAssertEqual(((extended.tracking["focusSession"] as? [String: Any])?["plannedDurationSeconds"] as? Int), 900)
        let paused = try store.admitFocus(intent(session: session, kind: "pause")) { _ in true }
        XCTAssertEqual((paused.tracking["focusSession"] as? [String: Any])?["phase"] as? String, "paused")
        let stale = try store.admitFocus(intent(session: session, kind: "pause", task: "other-task")) { _ in true }
        XCTAssertEqual((stale.outcome["accepted"] as? Bool), false)
        let stopped = try store.admitFocus(intent(session: session, kind: "stop")) { _ in true }
        XCTAssertEqual((stopped.tracking["focusSession"] as? [String: Any])?["phase"] as? String, "stopped")
        let terminal = try store.admitFocus(intent(session: session, kind: "stop")) { _ in true }
        XCTAssertEqual((terminal.outcome["accepted"] as? Bool), false)
        let reloaded = try XCTUnwrap(store.load())
        XCTAssertEqual(reloaded.generation, 6)
    }

    func testDuplicateRetryReturnsStoredOutcomeWithoutNewEffects() throws {
        let (store, _) = try store()
        let session = UUID().uuidString.lowercased()
        let id = UUID().uuidString.lowercased()
        let first = try store.admitFocus(intent(session: session, kind: "start", duration: 600, id: id)) { _ in true }
        let second = try store.admitFocus(intent(session: session, kind: "start", duration: 600, id: id)) { _ in true }
        XCTAssertTrue(second.duplicate)
        XCTAssertEqual(second.generation, first.generation)
        XCTAssertEqual(second.tracking["focusSession"] as? [String: Any] as NSDictionary?,
            first.tracking["focusSession"] as? [String: Any] as NSDictionary?)
        let reloaded = try XCTUnwrap(store.load())
        XCTAssertEqual(reloaded.generation, 1)
    }

    func testClosedTaskMalformedAndCompleteIntentsFailClosed() throws {
        let (store, _) = try store()
        let session = UUID().uuidString.lowercased()
        let before = try XCTUnwrap(store.load())
        XCTAssertThrowsError(try store.admitFocus(intent(session: session, kind: "start", duration: 600)) { _ in false })
        XCTAssertThrowsError(try store.admitFocus(intent(session: session, kind: "complete")) { _ in true })
        XCTAssertThrowsError(try store.admitFocus(["kind": "start"]) { _ in true })
        XCTAssertEqual(try store.load(), before)
    }

    func testCrossKindIdentityCollisionFailsClosed() throws {
        let (dir, defaults) = try isolated()
        let id = UUID().uuidString.lowercased()
        let store = try CausalJournalStore(accountId: id, directory: dir, defaults: defaults)
        _ = try store.prepare(tracking: ["date": "2026-09-08", "planViewCount": 0, "dailyPostponeCount": 0])
        _ = try store.admitCounterDay(causalDayIntent(UUID().uuidString.lowercased(), kind: "establish"), actorId: "test")
        let clash = UUID().uuidString.lowercased()
        _ = try store.admitCounter(["actionId": clash, "day": "2026-09-08", "timeZone": "Atlantic/Canary",
            "counter": "planViewCount", "delta": 1, "capturedAt": "2026-09-08T10:00:00.000Z"], actorId: "test")
        XCTAssertThrowsError(try store.admitFocus(intent(session: UUID().uuidString.lowercased(), kind: "start", duration: 600, id: clash)) { _ in true })
        XCTAssertEqual(try store.load()?.generation, 2)
    }
}

private func causalDayIntent(_ id: String, kind: String, day: String = "2026-09-08") -> [String: Any] {
    ["actionId": id, "kind": kind, "day": day, "timeZone": "Atlantic/Canary", "capturedAt": "2026-09-08T10:00:00.000Z"]
}

private func causalCounterEvent(_ id: String, counter: String = "planViewCount", day: String = "2026-09-08", delta: Int = 1) -> [String: Any] {
    ["actionId": id, "day": day, "timeZone": "Atlantic/Canary", "counter": counter, "delta": delta,
     "capturedAt": "2026-09-08T10:00:00.000Z"] as [String: Any]
}

final class CausalCounterAdmissionTests: XCTestCase {
    private func isolated() throws -> (URL, UserDefaults) {
        let suite = "goalflow.causal.counter.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock {
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: dir)
        }
        return (dir, defaults)
    }

    private func prepared() throws -> (CausalJournalStore, String) {
        let (dir, defaults) = try isolated()
        let id = UUID().uuidString.lowercased()
        let store = try CausalJournalStore(accountId: id, directory: dir, defaults: defaults)
        _ = try store.prepare(tracking: ["date": "2026-09-08", "planViewCount": 27, "dailyPostponeCount": 3])
        return (store, id)
    }

    func testEstablishAndIncrementsComposeWithIdempotentRetries() throws {
        let (store, _) = try prepared()
        let established = try store.admitCounterDay(causalDayIntent(UUID().uuidString.lowercased(), kind: "establish"), actorId: "test")
        XCTAssertFalse(established.duplicate)
        XCTAssertEqual(established.outcome["baselinePending"] as? Bool, false)
        let first = try store.admitCounter(causalCounterEvent(UUID().uuidString.lowercased()), actorId: "test")
        XCTAssertEqual((first.outcome["baselinePending"] as? Bool), false)
        XCTAssertEqual(first.tracking?["planViewCount"] as? Int, 28)
        XCTAssertEqual(first.tracking?["dailyPostponeCount"] as? Int, 3)
        let second = try store.admitCounter(causalCounterEvent(UUID().uuidString.lowercased(), counter: "dailyPostponeCount"), actorId: "test")
        XCTAssertEqual(second.tracking?["planViewCount"] as? Int, 28)
        XCTAssertEqual(second.tracking?["dailyPostponeCount"] as? Int, 4)
        XCTAssertEqual(second.generation, 3)
        let reloaded = try XCTUnwrap(store.load())
        XCTAssertEqual(reloaded.generation, 3)
    }

    func testUnknownDayRetainsWithoutProjectingYesterday() throws {
        let (store, _) = try prepared()
        _ = try store.admitCounterDay(causalDayIntent(UUID().uuidString.lowercased(), kind: "establish"), actorId: "test")
        let pending = try store.admitCounter(causalCounterEvent(UUID().uuidString.lowercased(), day: "2026-09-09"), actorId: "test")
        XCTAssertEqual(pending.outcome["baselinePending"] as? Bool, true)
        XCTAssertNil(pending.tracking)
        let tracking = try XCTUnwrap(store.load()?.trackingValue?.value as? [String: Any])
        XCTAssertEqual(tracking["date"] as? String, "2026-09-08")
        XCTAssertEqual(tracking["planViewCount"] as? Int, 27)
    }

    func testInvalidEventsAndDoubleEstablishFailClosed() throws {
        let (store, _) = try prepared()
        let before = try XCTUnwrap(store.load())
        let badDay = causalDayIntent(UUID().uuidString.lowercased(), kind: "establish")
        var tampered = badDay.merging(["day": "09-08"]) { _, new in new }
        XCTAssertThrowsError(try store.admitCounterDay(tampered, actorId: "test"))
        XCTAssertThrowsError(try store.admitCounter(causalCounterEvent(UUID().uuidString.lowercased(), counter: "frogs"), actorId: "test"))
        XCTAssertThrowsError(try store.admitCounter(causalCounterEvent(UUID().uuidString.lowercased(), day: "2026-09-08", delta: 0), actorId: "test"))
        XCTAssertEqual(try store.load(), before)
        _ = try store.admitCounterDay(causalDayIntent(UUID().uuidString.lowercased(), kind: "establish"), actorId: "test")
        let settled = try XCTUnwrap(store.load())
        XCTAssertThrowsError(try store.admitCounterDay(causalDayIntent(UUID().uuidString.lowercased(), kind: "establish"), actorId: "test"))
        XCTAssertEqual(try store.load(), settled)
    }
}

final class CausalTransportTests: XCTestCase {
    private struct StubTransport: SyncTransport {
        var userId = "11111111-1111-4111-8111-111111111111"
        var status: Int
        var body: Data
        func currentUserId() async throws -> String { userId }
        func request(path: String, method: String, headers: [String: String], body: Data?) async throws -> (Data, HTTPURLResponse) {
            let response = HTTPURLResponse(url: URL(string: "https://example.com")!, statusCode: status, httpVersion: nil, headerFields: nil)!
            return (self.body, response)
        }
    }

    private func prepared() throws -> (CausalJournalStore, String) {
        let suite = "goalflow.causal.transport.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock {
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: dir)
        }
        let id = UUID().uuidString.lowercased()
        let store = try CausalJournalStore(accountId: id, directory: dir, defaults: defaults)
        _ = try store.prepare(tracking: ["date": "2026-09-08", "planViewCount": 27, "dailyPostponeCount": 3])
        return (store, id)
    }

    private func started(_ store: CausalJournalStore) throws -> (session: String, actionId: String, command: [String: Any]) {
        let session = UUID().uuidString.lowercased()
        let actionId = UUID().uuidString.lowercased()
        let admitted = try store.admitFocus([
            "actionId": actionId, "kind": "start", "sessionId": session, "taskId": "task",
            "capturedAt": "2026-09-08T10:00:00.000Z", "durationSeconds": 600, "actorId": "test"
        ]) { _ in true }
        XCTAssertFalse(admitted.duplicate)
        let state = try XCTUnwrap(store.load())
        let command = try XCTUnwrap(state.focusOutbox[actionId]?.value as? [String: Any])
        return (session, actionId, command)
    }

    private func acceptedReceipt(operation: [String: Any], epoch: String, account: String, projection: [String: Any]) -> [String: Any] {
        ["schemaVersion": 2, "epoch": epoch, "projectionRevision": 1, "operation": operation, "accepted": true,
         "outcome": ["accepted": true, "code": "APPLIED", "revision": (operation["command"] as? [String: Any])?["actionId"] ?? NSNull()],
         "record": ["user_id": account, "entity_type": "tracking", "entity_id": "singleton", "version": 2, "server_version": 5,
                    "device_id": "causal-test", "updated_at": "2026-09-08T10:00:01.000Z", "deleted_at": NSNull(), "payload": ["focusSession": projection]]] as [String: Any]
    }

    func testSharedFixtureReceiptsValidateAndTamperingFails() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("tests/fixtures/s2/action-receipts-v2.json"))) as? [String: Any])
        let account = try XCTUnwrap(fixture["accountId"] as? String)
        let cases = try XCTUnwrap(fixture["cases"] as? [[String: Any]])
        XCTAssertEqual(cases.count, 4)
        for item in cases {
            let operation = try XCTUnwrap(item["operation"] as? [String: Any])
            let receipt = try XCTUnwrap(item["receipt"] as? [String: Any])
            let type = try XCTUnwrap(operation["type"] as? String)
            if type == "completion" {
                XCTAssertThrowsError(try CausalReceiptValidator.assert(operation: operation, receipt: receipt, accountId: account))
                continue
            }
            try CausalReceiptValidator.assert(operation: operation, receipt: receipt, accountId: account)
            var tampered = receipt
            tampered["epoch"] = UUID().uuidString.lowercased()
            XCTAssertThrowsError(try CausalReceiptValidator.assert(operation: operation, receipt: tampered, accountId: account))
            var flipped = receipt
            flipped["accepted"] = !(receipt["accepted"] as? Bool ?? true)
            XCTAssertThrowsError(try CausalReceiptValidator.assert(operation: operation, receipt: flipped, accountId: account))
            XCTAssertThrowsError(try CausalReceiptValidator.assert(operation: operation, receipt: receipt, accountId: UUID().uuidString.lowercased()))
        }
    }

    func testRequestPersistenceIsImmutableAndReceiptRetiresAtomically() throws {
        let (store, id) = try prepared()
        let started = try started(store)
        let epoch = UUID().uuidString.lowercased()
        let bytes = try CausalTransport.operationBytes(type: "focus", epoch: epoch, command: started.command)
        let operation = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(try store.saveRequest(actionId: started.actionId, bytes: bytes)["epoch"] as? String, epoch)
        XCTAssertEqual(try store.saveRequest(actionId: started.actionId, bytes: bytes)["epoch"] as? String, epoch)
        var altered = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        altered["epoch"] = UUID().uuidString.lowercased()
        let alteredBytes = try XCTUnwrap(stableJsonData(altered))
        XCTAssertThrowsError(try store.saveRequest(actionId: started.actionId, bytes: alteredBytes))
        let journal = try XCTUnwrap(store.load())
        let focus = Dictionary(uniqueKeysWithValues: journal.focus.map { ($0.key, $0.value.value ?? NSNull()) })
        let sessions = try XCTUnwrap(focus["sessions"] as? [String: Any])
        let projectionValue = try XCTUnwrap((sessions[started.session] as? [String: Any])?["projection"] as? [String: Any])
        let receipt = acceptedReceipt(operation: operation, epoch: epoch, account: id, projection: projectionValue)
        let applied = try store.commitReceipt(actionId: started.actionId, receipt: receipt)
        XCTAssertFalse(applied.duplicate)
        XCTAssertTrue(applied.accepted)
        let after = try XCTUnwrap(store.load())
        XCTAssertNil(after.focusOutbox[started.actionId])
        XCTAssertNotNil(after.causalReceipts[started.actionId])
        XCTAssertNotNil(after.causalRequests[started.actionId])
        let again = try store.commitReceipt(actionId: started.actionId, receipt: receipt)
        XCTAssertTrue(again.duplicate)
        var mismatched = receipt
        mismatched["projectionRevision"] = 2
        XCTAssertThrowsError(try store.commitReceipt(actionId: started.actionId, receipt: mismatched))
    }

    func testRejectedReceiptRetainsPendingIntent() throws {
        let (store, _) = try prepared()
        let started = try started(store)
        let epoch = UUID().uuidString.lowercased()
        let bytes = try CausalTransport.operationBytes(type: "focus", epoch: epoch, command: started.command)
        let operation = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        _ = try store.saveRequest(actionId: started.actionId, bytes: bytes)
        var rejected = acceptedReceipt(operation: operation, epoch: epoch,
            account: (operation["command"] as? [String: Any])?["accountId"] as? String ?? "",
            projection: ["schemaVersion": 1, "sessionId": started.session, "taskId": "task", "phase": "active",
                         "plannedDurationSeconds": 600, "startedAt": "2026-09-08T10:00:00.000Z",
                         "updatedAt": "2026-09-08T10:00:00.000Z", "elapsedSeconds": 0, "pausedAt": NSNull(), "endedAt": NSNull()])
        rejected["accepted"] = false
        rejected["outcome"] = ["accepted": false, "code": "STALE_REVISION", "revision": started.session]
        let result = try store.commitReceipt(actionId: started.actionId, receipt: rejected)
        XCTAssertFalse(result.duplicate)
        XCTAssertFalse(result.accepted)
        let after = try XCTUnwrap(store.load())
        XCTAssertNotNil(after.focusOutbox[started.actionId])
        XCTAssertNotNil(after.causalReceipts[started.actionId])
    }

    func testReceiptWithoutRequestFailsClosed() throws {
        let (store, _) = try prepared()
        _ = try started(store)
        XCTAssertThrowsError(try store.commitReceipt(actionId: UUID().uuidString.lowercased(), receipt: ["accepted": true]))
    }

    func testSendBoundsAndClassifiesWithoutRetiring() async throws {
        let body = Data(repeating: 0x7b, count: 100)
        let ok = try await CausalTransport.send(operation: body, via: StubTransport(status: 200, body: Data("{\"ok\":true}".utf8)))
        XCTAssertEqual(ok.count, 11)
        await XCTAssertThrowsErrorAsync(try await CausalTransport.send(operation: body, via: StubTransport(status: 409, body: Data())),
            match: "review")
        await XCTAssertThrowsErrorAsync(try await CausalTransport.send(operation: body, via: StubTransport(status: 503, body: Data())),
            match: "temporarily unavailable")
        await XCTAssertThrowsErrorAsync(try await CausalTransport.send(operation: Data(repeating: 0x7b, count: CausalTransport.maxRequestBytes + 1),
            via: StubTransport(status: 200, body: Data())), match: "envelope")
        await XCTAssertThrowsErrorAsync(try await CausalTransport.send(operation: body,
            via: StubTransport(status: 200, body: Data(repeating: 0x7b, count: CausalTransport.maxReceiptBytes + 1))), match: "envelope")
        let oversized: [String: Any] = ["payload": String(repeating: "x", count: CausalTransport.maxRequestBytes)]
        XCTAssertThrowsError(try CausalTransport.operationBytes(type: "focus", epoch: UUID().uuidString.lowercased(), command: oversized))
        XCTAssertThrowsError(try CausalTransport.operationBytes(type: "completion", epoch: UUID().uuidString.lowercased(), command: [:]))
    }
}

private func XCTAssertThrowsErrorAsync(
    _ expression: @autoclosure () async throws -> some Any,
    match: String, file: StaticString = #filePath, line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("Expected error containing '\(match)'", file: file, line: line)
    } catch {
        XCTAssert((error as? LocalizedError)?.errorDescription?.contains(match) == true,
            "Error '\(error)' does not mention '\(match)'", file: file, line: line)
    }
}
