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
