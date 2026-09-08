import XCTest
@testable import GoalflowMac

final class DeliberatePlanningTests: XCTestCase {
    func testSharedPlanningFixturesAndImmutableDuplicates() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("tests/fixtures/planning/deliberate-v1.json"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        for scenario in try XCTUnwrap(fixture["cases"] as? [[String: Any]]) {
            let available = try XCTUnwrap(scenario["available"] as? [[String: Any]]).map { DeliberatePlanning.Task(id: $0["id"] as! String, precedence: $0["precedence"] as! Int) }
            let command = scenario["command"] as! [String: Any], setting = scenario["setting"] as! String
            let result = try DeliberatePlanning.apply(scenario["policy"] as! [String: Any], command: command, available: available, xp: scenario["xp"] as! Int, setting: setting)
            var actual = result.receipt; actual.removeValue(forKey: "command"); actual["xp"] = result.xp
            XCTAssertEqual(stableJson(actual), stableJson(scenario["expected"]), scenario["name"] as! String)
            let duplicate = try DeliberatePlanning.apply(result.policy, command: command, available: available, xp: result.xp, setting: setting)
            XCTAssertTrue(duplicate.replay); XCTAssertEqual(result.xp, duplicate.xp)
            XCTAssertEqual(stableJson(result.receipt), stableJson(duplicate.receipt))
        }
    }
    func testPolicyRejectsAlteredHistoryAndWrongAccount() throws {
        let account = "00000000-0000-4000-8000-000000000002", day = "2026-09-08"
        let policy = try DeliberatePlanning.initial(accountID: account, day: day)
        try DeliberatePlanning.validatePolicy(policy, accountID: account, day: day)
        XCTAssertThrowsError(try DeliberatePlanning.validatePolicy(policy, accountID: "another", day: day))
        let command: [String: Any] = ["schemaVersion": 1, "accountId": account, "localDate": day,
            "operationId": "00000000-0000-4000-8000-000000000003", "baselineRevision": NSNull(),
            "proposedOrder": [String](), "ratings": [[String: Any]](), "maximumAcceptedXp": 0,
            "capturedAt": "2026-09-08T10:00:00.000Z"]
        let reply = try DeliberatePlanning.apply(policy, command: command, available: [], xp: 10, setting: "classic")
        try DeliberatePlanning.validatePolicy(reply.policy, accountID: account, day: day)
        var invalid = reply.policy
        invalid["history"] = [reply.receipt, reply.receipt]
        XCTAssertThrowsError(try DeliberatePlanning.validatePolicy(invalid, accountID: account, day: day))
        invalid = reply.policy; invalid["acceptedReplans"] = 3
        XCTAssertThrowsError(try DeliberatePlanning.validatePolicy(invalid, accountID: account, day: day))
    }

    func testPolicyRefreshWaitsForCursorAndPreservesDraftAcrossReload() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let suite = "planning-tests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { try? FileManager.default.removeItem(at: directory); defaults.removePersistentDomain(forName: suite) }
        let meta = SyncMetaStore(fileURL: directory.appendingPathComponent("sync.json"), defaults: defaults)
        let account = "00000000-0000-4000-8000-000000000002", day = "2026-09-08"
        try meta.bind(to: account)
        let store = DeliberatePlanningStore(metaStore: meta)
        let draft: [String: Any] = ["schemaVersion": 1, "accountId": account, "localDate": day,
            "baselineRevision": NSNull(), "proposedOrder": ["task-a"], "ratings": [[String: Any]](),
            "maximumAcceptedXp": 0, "updatedAt": "2026-09-08T10:00:00.000Z"]
        try store.saveDraft(draft, accountID: account, day: day)
        let record: [String: Any] = ["user_id": account, "entity_type": "daily_plans", "entity_id": day,
            "version": 1, "server_version": 5, "device_id": "test-device", "deleted_at": NSNull(),
            "updated_at": "2026-09-08T10:00:00.000Z", "payload": ["localDate": day]]
        let response: [String: Any] = ["schemaVersion": 1, "accountId": account, "enforcementEnabled": true,
            "policy": try DeliberatePlanning.initial(accountID: account, day: day), "records": [record]]
        XCTAssertFalse(try store.commitDay(response, accountID: account, day: day))
        var advanced = try meta.load(); advanced.cursor = 5; try meta.save(advanced)
        XCTAssertTrue(try store.commitDay(response, accountID: account, day: day))
        let reopened = DeliberatePlanningStore(metaStore: meta)
        let state = try reopened.load(accountID: account)
        XCTAssertEqual(stableJson((state["drafts"] as! [String: Any])[day]), stableJson(draft))
        XCTAssertNotNil((state["days"] as! [String: Any])[day])
        XCTAssertThrowsError(try reopened.load(accountID: "another"))
        let command: [String: Any] = ["schemaVersion": 1, "accountId": account, "localDate": day,
            "operationId": "00000000-0000-4000-8000-000000000003", "baselineRevision": NSNull(),
            "proposedOrder": [String](), "ratings": [[String: Any]](), "maximumAcceptedXp": 0,
            "capturedAt": "2026-09-08T10:00:00.000Z"]
        let confirmed = try DeliberatePlanning.apply(response["policy"] as! [String: Any], command: command, available: [], xp: 10, setting: "classic")
        var newer = response; newer["policy"] = confirmed.policy
        XCTAssertTrue(try reopened.commitDay(newer, accountID: account, day: day))
        XCTAssertFalse(try reopened.commitDay(response, accountID: account, day: day))
        XCTAssertEqual(stableJson(try reopened.policy(accountID: account, day: day)), stableJson(confirmed.policy))
        var invalid = response; invalid["enforcementEnabled"] = 1
        XCTAssertThrowsError(try reopened.commitDay(invalid, accountID: account, day: day))
    }

    func testLegacyLockSurvivesPlanClearAndProtectsOrderOnly() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let suite = "planning-lock-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { try? FileManager.default.removeItem(at: directory); defaults.removePersistentDomain(forName: suite) }
        let meta = SyncMetaStore(fileURL: directory.appendingPathComponent("sync.json"), defaults: defaults)
        let tasks = LocalTaskStore(fileURL: directory.appendingPathComponent("goalflow.tasks.json"), defaults: defaults, syncMetaStore: meta)
        let plans = DailyPlanStore(fileURL: directory.appendingPathComponent("dailyPlans.json"), defaults: defaults, syncMetaStore: meta)
        let day = "2026-09-08"
        var a = GoalflowTask(id: "a", title: "A", scheduledFor: day, plannedOrder: 0)
        let b = GoalflowTask(id: "b", title: "B", scheduledFor: day, plannedOrder: 1)
        try tasks.saveAll([a, b])
        try plans.save(DailyPlan(localDate: day, confirmedAt: "2026-09-08T10:00:00Z", taskIds: ["a", "b"]))
        XCTAssertTrue(try plans.isOrderLocked(for: day))
        a.plannedOrder = 2
        XCTAssertThrowsError(try tasks.saveAll([a, b]))
        XCTAssertEqual(try tasks.loadAll().map(\.id), ["a", "b"])
        a.plannedOrder = 0; a.notes = "Saved independently"
        try tasks.saveAll([a, b])
        XCTAssertEqual(try tasks.loadAll().first?.notes, "Saved independently")
        try plans.clearAll()
        XCTAssertNil(try plans.load(for: day))
        XCTAssertTrue(try plans.isOrderLocked(for: day))
        a.plannedOrder = 2
        XCTAssertThrowsError(try tasks.saveAll([a, b]))
        _ = try tasks.completeTask(id: "a", actualDurationMinutes: 10, flowState: nil)
        XCTAssertTrue(try plans.isOrderLocked(for: day))
        XCTAssertFalse(try plans.isOrderLocked(for: "2026-09-09"))
    }

    func testFirstAccountBindingMigratesOnlyUnsubmittedLocalPlanning() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let suite = "planning-binding-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { try? FileManager.default.removeItem(at: directory); defaults.removePersistentDomain(forName: suite) }
        let meta = SyncMetaStore(fileURL: directory.appendingPathComponent("sync.json"), defaults: defaults)
        let store = DeliberatePlanningStore(metaStore: meta)
        let day = "2026-09-08", unbound = "unbound-local-workspace"
        let policy = try store.policy(accountID: unbound, day: day,
            legacy: DailyPlan(localDate: day, confirmedAt: "2026-09-08T10:00:00Z", taskIds: ["a", "b"]))
        let draft: [String: Any] = ["schemaVersion": 1, "accountId": unbound, "localDate": day,
            "baselineRevision": policy["revision"]!, "proposedOrder": ["b", "a"], "ratings": [[String: Any]](),
            "maximumAcceptedXp": 0, "updatedAt": "2026-09-08T10:00:00.000Z"]
        try store.saveDraft(draft, accountID: unbound, day: day)
        let account = "00000000-0000-4000-8000-000000000002"
        try meta.bind(to: account)
        let migrated = try store.policy(accountID: account, day: day)
        XCTAssertEqual(migrated["accountId"] as? String, account)
        XCTAssertEqual(migrated["revision"] as? String, policy["revision"] as? String)
        let reopened = DeliberatePlanningStore(metaStore: meta)
        let state = try reopened.load(accountID: account)
        let savedDraft = (state["drafts"] as! [String: [String: Any]])[day]!
        XCTAssertEqual(savedDraft["accountId"] as? String, account)
        XCTAssertEqual(savedDraft["proposedOrder"] as? [String], ["b", "a"])
        XCTAssertThrowsError(try reopened.load(accountID: unbound))
        XCTAssertThrowsError(try meta.bind(to: "00000000-0000-4000-8000-000000000004"))
    }

}
