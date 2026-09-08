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
