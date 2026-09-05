import XCTest
@testable import GoalflowMac

final class StableJsonTests: XCTestCase {
    func test_sorts_keys() {
        let a: [String: Any] = ["b": 2, "a": 1]
        let b: [String: Any] = ["a": 1, "b": 2]
        XCTAssertEqual(stableJson(a), stableJson(b))
    }
    func test_nested_sorts() {
        let a: [String: Any] = ["z": ["b": 2, "a": 1], "a": 1]
        let b: [String: Any] = ["a": 1, "z": ["a": 1, "b": 2]]
        XCTAssertEqual(stableJson(a), stableJson(b))
    }
    func test_nil_and_array() {
        XCTAssertEqual(stableJson(nil), "null")
        XCTAssertEqual(stableJson([1,2,3]), "[1,2,3]")
    }

    func test_any_codable_preserves_integer_and_boolean_types() throws {
        let original = AnyCodable([
            "zero": 0,
            "one": 1,
            "enabled": true,
            "disabled": false
        ])
        let decoded = try JSONDecoder().decode(AnyCodable.self, from: JSONEncoder().encode(original))
        let object = try XCTUnwrap(decoded.value as? [String: Any])
        XCTAssertEqual(object["zero"] as? Int, 0)
        XCTAssertEqual(object["one"] as? Int, 1)
        XCTAssertEqual(object["enabled"] as? Bool, true)
        XCTAssertEqual(object["disabled"] as? Bool, false)
        XCTAssertEqual(
            stableJson(decoded.value),
            "{\"disabled\":false,\"enabled\":true,\"one\":1,\"zero\":0}"
        )
    }

    func test_any_codable_preserves_nested_null_across_repeated_round_trips() throws {
        let original = AnyCodable(["deletedAt": NSNull(), "nested": [NSNull()]])
        let first = try JSONDecoder().decode(AnyCodable.self, from: JSONEncoder().encode(original))
        let second = try JSONDecoder().decode(AnyCodable.self, from: JSONEncoder().encode(first))
        XCTAssertEqual(stableJson(second.value), "{\"deletedAt\":null,\"nested\":[null]}")
    }
}

final class TaskWireAdapterTests: XCTestCase {
    func test_browser_task_payload_round_trips_without_losing_shared_or_unknown_fields() throws {
        let createdAt = 1_788_393_600_123
        let updatedAt = 1_788_393_660_456
        let payload: [String: Any] = [
            "id": "task-1",
            "title": "Shared task",
            "description": "Browser notes",
            "completed": true,
            "lifecycleStatus": "completed",
            "isFrog": true,
            "createdAt": createdAt,
            "updatedAt": updatedAt,
            "completedAt": updatedAt,
            "duration": 45,
            "actualDuration": 42,
            "hashtags": ["focus", "beta"],
            "dateAssigned": "2026-09-03",
            "schedulePrecision": "day",
            "scheduledFor": "2026-09-03",
            "plannedOrder": 3,
            "frogFailures": 2,
            "beforeFrog": false,
            "source": "manual",
            "version": 7,
            "flowState": "flow",
            "futureField": ["preserve": true]
        ]

        let task = try GoalflowTask(syncDictionary: payload)
        XCTAssertEqual(task.notes, "Browser notes")
        XCTAssertEqual(task.tags, ["focus", "beta"])
        XCTAssertEqual(task.status, .completed)
        XCTAssertEqual(task.durationMinutes, 45)
        XCTAssertEqual(task.flowState, .flow)
        XCTAssertEqual(task.actualDurationMinutes, 42)

        let roundTrip = try task.toSyncDictionary()
        XCTAssertEqual(roundTrip["description"] as? String, "Browser notes")
        XCTAssertEqual(roundTrip["hashtags"] as? [String], ["focus", "beta"])
        XCTAssertEqual(roundTrip["completed"] as? Bool, true)
        XCTAssertEqual(roundTrip["lifecycleStatus"] as? String, "completed")
        XCTAssertEqual(roundTrip["duration"] as? Int, 45)
        XCTAssertEqual(strictJSONInteger(roundTrip["createdAt"]), createdAt)
        XCTAssertEqual(strictJSONInteger(roundTrip["updatedAt"]), updatedAt)
        XCTAssertEqual(stableJson(roundTrip["futureField"]), "{\"preserve\":true}")
    }

    func test_ambiguous_boolean_does_not_become_a_completion() {
        let payload: [String: Any] = [
            "id": "task-1", "title": "Shared task", "completed": 1,
            "createdAt": 1_788_393_600_000, "updatedAt": 1_788_393_600_000,
            "dateAssigned": "2026-09-03", "version": 1
        ]
        XCTAssertThrowsError(try GoalflowTask(syncDictionary: payload))
    }
}

final class SyncMetaTests: XCTestCase {
    private enum InjectedFailure: Error { case simulatedProcessDeath }

    func test_empty_meta() throws {
        let m = emptySyncMeta()
        XCTAssertEqual(m.schemaVersion, 3)
        XCTAssertNil(m.accountUserId)
        XCTAssertEqual(m.cursor, 0)
        XCTAssertTrue(m.outbox.isEmpty)
    }
    func test_normalize_duplicate_mutation_throws() {
        var m = emptySyncMeta()
        let mut = SyncMutation(mutationId: "dup", deviceId: "d", entityType: "tasks", entityId: "1", baseServerVersion: nil, version: 1, payload: AnyCodable(["id":"1"]), updatedAt: "2026-09-01T00:00:00Z", deletedAt: nil, dependsOnMutationId: nil, resolvesConflictId: nil, attemptedAt: nil)
        m.outbox = [mut, mut]
        let store = SyncMetaStore(fileURL: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString), defaults: UserDefaults(suiteName: UUID().uuidString)!)
        XCTAssertThrowsError(try store.normalizeSyncMeta(m))
    }
    func test_normalize_schema_mismatch_throws() {
        var m = emptySyncMeta()
        m.schemaVersion = 99
        let store = SyncMetaStore(fileURL: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString), defaults: UserDefaults(suiteName: UUID().uuidString)!)
        XCTAssertThrowsError(try store.normalizeSyncMeta(m))
    }

    func test_schema_two_migrates_without_discarding_outbox() throws {
        let suite = "goalflow.sync.migration.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".json")
        var legacy = emptySyncMeta()
        legacy.schemaVersion = 2
        legacy.outbox = [SyncMutation(
            mutationId: "pending-mutation",
            deviceId: "device",
            entityType: "tasks",
            entityId: "durable-task-id",
            baseServerVersion: nil,
            version: 1,
            payload: AnyCodable(["id": "durable-task-id"]),
            updatedAt: "2026-09-03T00:00:00Z",
            deletedAt: nil,
            dependsOnMutationId: nil,
            resolvesConflictId: nil,
            attemptedAt: nil
        )]
        defaults.set(try JSONEncoder().encode(legacy), forKey: "goalflow.sync.meta.v2")
        let store = SyncMetaStore(fileURL: file, defaults: defaults)
        let migrated = try store.load()
        XCTAssertEqual(migrated.schemaVersion, 3)
        XCTAssertEqual(migrated.outbox.map(\.mutationId), ["pending-mutation"])
        XCTAssertNil(migrated.accountUserId)
    }

    func test_corrupt_meta_never_becomes_an_empty_outbox() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".json")
        try Data("damaged".utf8).write(to: file, options: [.atomic])
        let store = SyncMetaStore(
            fileURL: file,
            defaults: try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        )
        XCTAssertThrowsError(try store.load())
    }

    func test_workspace_binding_is_immutable() throws {
        let store = SyncMetaStore(
            fileURL: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".json"),
            defaults: try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        )
        let first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        let second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        XCTAssertEqual(try store.bindingState(for: first), .unbound)
        try store.bind(to: first)
        XCTAssertEqual(try store.bindingState(for: first), .bound)
        XCTAssertEqual(try store.bindingState(for: second), .differentAccount)
        XCTAssertThrowsError(try store.bind(to: second))
        XCTAssertEqual(try store.load().accountUserId, first)
    }

    func test_local_task_and_outbox_commit_together() throws {
        let suite = "goalflow.sync.atomic.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let metaStore = SyncMetaStore(fileURL: directory.appendingPathComponent("sync.json"), defaults: defaults)
        let taskStore = LocalTaskStore(
            fileURL: directory.appendingPathComponent("goalflow.tasks.json"),
            defaults: defaults,
            syncMetaStore: metaStore,
            deviceIdStore: DeviceIdStore(defaults: defaults)
        )
        let task = GoalflowTask(id: "durable-task-id", title: "Persist me", scheduledFor: "2026-09-03")

        try taskStore.saveAll([task])

        XCTAssertEqual(try taskStore.loadAll().map(\.id), [task.id])
        let meta = try metaStore.load()
        XCTAssertEqual(meta.outbox.count, 1)
        XCTAssertEqual(meta.outbox.first?.entityId, task.id)
        XCTAssertEqual(stableJson(meta.outbox.first?.payload.value), stableJson(try task.toSyncDictionary()))
    }

    func test_goal_stores_stage_every_durable_field() throws {
        let suite = "goalflow.sync.goal-fields.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let metaStore = SyncMetaStore(fileURL: directory.appendingPathComponent("sync.json"), defaults: defaults)
        let deviceStore = DeviceIdStore(defaults: defaults)
        let goalStore = GoalStore(
            fileURL: directory.appendingPathComponent("goals.json"),
            defaults: defaults,
            syncMetaStore: metaStore,
            deviceIdStore: deviceStore
        )
        let trueNorthStore = TrueNorthStore(
            fileURL: directory.appendingPathComponent("truenorth.json"),
            defaults: defaults,
            syncMetaStore: metaStore,
            deviceIdStore: deviceStore
        )

        try goalStore.saveAll([Goal(
            id: "goal-1",
            name: "Complete goal",
            description: "Keep this description",
            color: "#123456",
            createdAt: 1_788_393_600_123
        )])
        try trueNorthStore.saveAll([TrueNorthGoal(
            id: "north-1",
            vision: "A complete vision",
            isMoneyGoal: true,
            tangibleReality: "Concrete outcome",
            sensoryDetails: "Detailed evidence",
            planB: "Safe fallback",
            importance: 9,
            anchorHabit: "Daily review",
            anchorTask: "Weekly plan",
            createdAt: 1_788_393_600_456
        )])

        let outbox = try metaStore.load().outbox
        let goalPayload = try XCTUnwrap(outbox.first(where: { $0.entityType == "goals" })?.payload.value as? [String: Any])
        XCTAssertEqual(goalPayload["description"] as? String, "Keep this description")
        XCTAssertEqual(goalPayload["color"] as? String, "#123456")
        XCTAssertEqual(strictJSONInteger(goalPayload["createdAt"]), 1_788_393_600_123)

        let trueNorthPayload = try XCTUnwrap(outbox.first(where: { $0.entityType == "truenorth" })?.payload.value as? [String: Any])
        XCTAssertEqual(trueNorthPayload["isMoneyGoal"] as? Bool, true)
        XCTAssertEqual(trueNorthPayload["tangibleReality"] as? String, "Concrete outcome")
        XCTAssertEqual(trueNorthPayload["sensoryDetails"] as? String, "Detailed evidence")
        XCTAssertEqual(trueNorthPayload["planB"] as? String, "Safe fallback")
        XCTAssertEqual(strictJSONInteger(trueNorthPayload["importance"]), 9)
        XCTAssertEqual(trueNorthPayload["anchorHabit"] as? String, "Daily review")
        XCTAssertEqual(trueNorthPayload["anchorTask"] as? String, "Weekly plan")
        XCTAssertEqual(strictJSONInteger(trueNorthPayload["createdAt"]), 1_788_393_600_456)
    }

    func test_pending_local_commit_recovers_after_interrupted_write() throws {
        let suite = "goalflow.sync.recovery.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let syncFile = directory.appendingPathComponent("sync.json")
        let interruptedMetaStore = SyncMetaStore(fileURL: syncFile, defaults: defaults) { stage in
            if stage == .localReplicaWritten(0) { throw InjectedFailure.simulatedProcessDeath }
        }
        let interruptedTaskStore = LocalTaskStore(
            fileURL: directory.appendingPathComponent("goalflow.tasks.json"),
            defaults: defaults,
            syncMetaStore: interruptedMetaStore,
            deviceIdStore: DeviceIdStore(defaults: defaults)
        )
        let task = GoalflowTask(id: "recoverable-task-id", title: "Recover me", scheduledFor: "2026-09-03")

        XCTAssertThrowsError(try interruptedTaskStore.saveAll([task]))
        XCTAssertTrue(FileManager.default.fileExists(atPath: syncFile.appendingPathExtension("local-commit.json").path))

        let recoveredMetaStore = SyncMetaStore(fileURL: syncFile, defaults: defaults)
        let recoveredTaskStore = LocalTaskStore(
            fileURL: directory.appendingPathComponent("goalflow.tasks.json"),
            defaults: defaults,
            syncMetaStore: recoveredMetaStore,
            deviceIdStore: DeviceIdStore(defaults: defaults)
        )
        XCTAssertEqual(try recoveredTaskStore.loadAll().map(\.id), [task.id])
        XCTAssertEqual(try recoveredMetaStore.load().outbox.map(\.entityId), [task.id])
        XCTAssertFalse(FileManager.default.fileExists(atPath: syncFile.appendingPathExtension("local-commit.json").path))
    }

    func test_damaged_local_file_repairs_from_valid_mirror() throws {
        let suite = "goalflow.sync.local-repair.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let taskFile = directory.appendingPathComponent("goalflow.tasks.json")
        let metaStore = SyncMetaStore(fileURL: directory.appendingPathComponent("sync.json"), defaults: defaults)
        let taskStore = LocalTaskStore(fileURL: taskFile, defaults: defaults, syncMetaStore: metaStore)
        let task = GoalflowTask(id: "repair-task-id", title: "Repair me", scheduledFor: "2026-09-03")
        try taskStore.saveAll([task])
        try Data("damaged".utf8).write(to: taskFile, options: [.atomic])

        XCTAssertEqual(try taskStore.loadAll().map(\.id), [task.id])
        XCTAssertEqual(try Data(contentsOf: taskFile), defaults.data(forKey: "goalflow.demo.tasks.v1"))
    }

    func test_two_damaged_local_replicas_never_become_empty() throws {
        let suite = "goalflow.sync.local-corrupt.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let taskFile = directory.appendingPathComponent("goalflow.tasks.json")
        let metaStore = SyncMetaStore(fileURL: directory.appendingPathComponent("sync.json"), defaults: defaults)
        let taskStore = LocalTaskStore(fileURL: taskFile, defaults: defaults, syncMetaStore: metaStore)
        try taskStore.saveAll([GoalflowTask(id: "preserved-task-id", title: "Preserve me", scheduledFor: "2026-09-03")])
        try Data("damaged-file".utf8).write(to: taskFile, options: [.atomic])
        defaults.set(Data("damaged-mirror".utf8), forKey: "goalflow.demo.tasks.v1")

        XCTAssertThrowsError(try taskStore.loadAll())
        XCTAssertEqual(try metaStore.load().outbox.map(\.entityId), ["preserved-task-id"])
        XCTAssertEqual(try Data(contentsOf: taskFile), Data("damaged-file".utf8))
    }
}

final class BuildStagingTests: XCTestCase {
    func test_noop_when_equal() throws {
        let prev: [[String: Any]] = [["id":"1","title":"A"]]
        let next: [[String: Any]] = [["id":"1","title":"A"]]
        let tx = try buildStagedLocalTransaction(storeName: "tasks", userKey: "u", previousValue: prev, nextValue: next, order: 1, now: "2026-09-01T00:00:00Z", randomUuid: { UUID().uuidString })
        XCTAssertNil(tx)
    }
    func test_per_record_diff_creates_mutation() throws {
        let prev: [[String: Any]] = [["id":"1","title":"A"]]
        let next: [[String: Any]] = [["id":"1","title":"B"]]
        let tx = try buildStagedLocalTransaction(storeName: "tasks", userKey: "u", previousValue: prev, nextValue: next, order: 1, now: "2026-09-01T00:00:00Z", randomUuid: { "m1" })
        XCTAssertNotNil(tx)
        XCTAssertEqual(tx?.changes.count, 1)
        XCTAssertEqual(tx?.changes.first?.entityId, "1")
    }
    func test_added_record() throws {
        let prev: [[String: Any]] = []
        let next: [[String: Any]] = [["id":"2","title":"New"]]
        let tx = try buildStagedLocalTransaction(storeName: "tasks", userKey: "u", previousValue: prev, nextValue: next, order: 1, now: "now", randomUuid: { UUID().uuidString })
        XCTAssertEqual(tx?.changes.count, 1)
        XCTAssertEqual(tx?.changes.first?.entityId, "2")
    }
    func test_deleted_record() throws {
        let prev: [[String: Any]] = [["id":"1","title":"A"]]
        let next: [[String: Any]] = []
        let tx = try buildStagedLocalTransaction(storeName: "tasks", userKey: "u", previousValue: prev, nextValue: next, order: 1, now: "now", randomUuid: { UUID().uuidString })
        XCTAssertEqual(tx?.changes.first?.deletedAt, "now")
    }
    func test_singleton_store() throws {
        let tx = try buildStagedLocalTransaction(storeName: "amalgam", userKey: "u", previousValue: "hello", nextValue: "world", order: 1, now: "now", randomUuid: { UUID().uuidString })
        XCTAssertEqual(tx?.changes.count, 1)
        XCTAssertEqual(tx?.changes.first?.entityId, "singleton")
    }
}

final class ReadyOutboxTests: XCTestCase {
    func test_dependency_gate() {
        var meta = emptySyncMeta()
        let m1 = SyncMutation(mutationId: "m1", deviceId: "d", entityType: "tasks", entityId: "1", baseServerVersion: 0, version: 1, payload: AnyCodable(["id":"1"]), updatedAt: "now", deletedAt: nil, dependsOnMutationId: nil, resolvesConflictId: nil, attemptedAt: nil)
        let m2 = SyncMutation(mutationId: "m2", deviceId: "d", entityType: "tasks", entityId: "1", baseServerVersion: nil, version: 2, payload: AnyCodable(["id":"1"]), updatedAt: "now", deletedAt: nil, dependsOnMutationId: "m1", resolvesConflictId: nil, attemptedAt: nil)
        meta.outbox = [m1, m2]
        let ready = readyOutbox(meta, limit: 50)
        XCTAssertEqual(ready.map(\.mutationId), ["m1"])
    }
    func test_one_per_entity() {
        var meta = emptySyncMeta()
        let m1 = SyncMutation(mutationId: "a", deviceId: "d", entityType: "tasks", entityId: "1", baseServerVersion: nil, version: 1, payload: AnyCodable([:]), updatedAt: "now", deletedAt: nil, dependsOnMutationId: nil, resolvesConflictId: nil, attemptedAt: nil)
        let m2 = SyncMutation(mutationId: "b", deviceId: "d", entityType: "tasks", entityId: "2", baseServerVersion: nil, version: 1, payload: AnyCodable([:]), updatedAt: "now", deletedAt: nil, dependsOnMutationId: nil, resolvesConflictId: nil, attemptedAt: nil)
        meta.outbox = [m1, m2]
        let ready = readyOutbox(meta, limit: 1)
        XCTAssertEqual(ready.count, 1)
    }
    func test_sort_version_then_id() {
        var meta = emptySyncMeta()
        let m2 = SyncMutation(mutationId: "b", deviceId: "d", entityType: "tasks", entityId: "1", baseServerVersion: nil, version: 2, payload: AnyCodable([:]), updatedAt: "now", deletedAt: nil, dependsOnMutationId: nil, resolvesConflictId: nil, attemptedAt: nil)
        let m1 = SyncMutation(mutationId: "a", deviceId: "d", entityType: "tasks", entityId: "2", baseServerVersion: nil, version: 1, payload: AnyCodable([:]), updatedAt: "now", deletedAt: nil, dependsOnMutationId: nil, resolvesConflictId: nil, attemptedAt: nil)
        meta.outbox = [m2, m1]
        let ready = readyOutbox(meta, limit: 50)
        XCTAssertEqual(ready.first?.mutationId, "a")
    }
}

final class ApplyPushResultsTests: XCTestCase {
    func test_server_snake_case_receipt_preserves_exact_record() throws {
        let payload: [String: Any] = ["id": "task-1", "version": 1]
        let record = try XCTUnwrap(parsePushReceiptRecord([
            "entity_type": "tasks",
            "entity_id": "task-1",
            "version": 1,
            "server_version": 7,
            "device_id": "device-a",
            "payload": payload,
            "updated_at": "2026-09-03T00:00:00.000Z",
            "deleted_at": NSNull()
        ]))
        XCTAssertEqual(record.entityType, "tasks")
        XCTAssertEqual(record.entityId, "task-1")
        XCTAssertEqual(record.version, 1)
        XCTAssertEqual(record.serverVersion, 7)
        XCTAssertEqual(record.deviceId, "device-a")
        XCTAssertEqual(stableJson(record.payload.value), stableJson(payload))
        XCTAssertEqual(record.updatedAt, "2026-09-03T00:00:00.000Z")
        XCTAssertNil(record.deletedAt)
    }

    func test_receipt_parser_rejects_boolean_and_fractional_versions() {
        let base: [String: Any] = [
            "entity_type": "tasks", "entity_id": "task-1", "device_id": "device-a",
            "version": 1, "server_version": 7, "payload": ["id": "task-1"],
            "updated_at": "2026-09-03T00:00:00.000Z", "deleted_at": NSNull()
        ]
        XCTAssertNil(parsePushReceiptRecord(base.merging(["version": true]) { _, replacement in replacement }))
        XCTAssertNil(parsePushReceiptRecord(base.merging(["server_version": 7.5]) { _, replacement in replacement }))
    }

    func test_accepted_proves_and_clears() throws {
        var meta = emptySyncMeta()
        let m = SyncMutation(mutationId: "m1", deviceId: "d", entityType: "tasks", entityId: "1", baseServerVersion: nil, version: 1, payload: AnyCodable(["id":"1","title":"A"]), updatedAt: "now", deletedAt: nil, dependsOnMutationId: nil, resolvesConflictId: nil, attemptedAt: nil)
        meta.outbox = [m]
        meta.versions[syncEntityKey("tasks","1")] = VersionPair(local: 1, server: nil)
        let rec = RemoteRecord(entityType: "tasks", entityId: "1", version: 1, serverVersion: 11, deviceId: "d", payload: AnyCodable(["id":"1","title":"A"]), updatedAt: "now", deletedAt: nil)
        let res = PushResult(mutationId: "m1", accepted: true, serverVersion: 11, replayMismatch: nil, serverMissing: nil, conflictId: nil, record: rec)
        let newMeta = try applyPushResults(meta, batch: [m], results: [res])
        XCTAssertTrue(newMeta.outbox.isEmpty)
        XCTAssertEqual(newMeta.versions[syncEntityKey("tasks","1")]?.server, 11)
    }
    func test_stableJson_mismatch_throws() {
        var meta = emptySyncMeta()
        let m = SyncMutation(mutationId: "m1", deviceId: "d", entityType: "tasks", entityId: "1", baseServerVersion: nil, version: 1, payload: AnyCodable(["id":"1","title":"A"]), updatedAt: "now", deletedAt: nil, dependsOnMutationId: nil, resolvesConflictId: nil, attemptedAt: nil)
        meta.outbox = [m]
        let rec = RemoteRecord(entityType: "tasks", entityId: "1", version: 1, serverVersion: 11, deviceId: "d", payload: AnyCodable(["id":"1","title":"B"]), updatedAt: "now", deletedAt: nil)
        let res = PushResult(mutationId: "m1", accepted: true, serverVersion: 11, replayMismatch: nil, serverMissing: nil, conflictId: nil, record: rec)
        XCTAssertThrowsError(try applyPushResults(meta, batch: [m], results: [res]))
    }
    func test_accepted_receipt_with_different_timestamp_throws() {
        var meta = emptySyncMeta()
        let m = SyncMutation(mutationId: "m1", deviceId: "d", entityType: "tasks", entityId: "1", baseServerVersion: nil, version: 1, payload: AnyCodable(["id":"1"]), updatedAt: "2026-09-03T00:00:00.000Z", deletedAt: nil, dependsOnMutationId: nil, resolvesConflictId: nil, attemptedAt: nil)
        meta.outbox = [m]
        let rec = RemoteRecord(entityType: "tasks", entityId: "1", version: 1, serverVersion: 11, deviceId: "d", payload: AnyCodable(["id":"1"]), updatedAt: "2026-09-03T00:00:01.000Z", deletedAt: nil)
        let res = PushResult(mutationId: "m1", accepted: true, serverVersion: 11, replayMismatch: nil, serverMissing: nil, conflictId: nil, record: rec)
        XCTAssertThrowsError(try applyPushResults(meta, batch: [m], results: [res]))
    }
    func test_accepted_receipt_with_different_device_throws() {
        var meta = emptySyncMeta()
        let m = SyncMutation(mutationId: "m1", deviceId: "device-a", entityType: "tasks", entityId: "1", baseServerVersion: nil, version: 1, payload: AnyCodable(["id":"1"]), updatedAt: "now", deletedAt: nil, dependsOnMutationId: nil, resolvesConflictId: nil, attemptedAt: nil)
        meta.outbox = [m]
        let rec = RemoteRecord(entityType: "tasks", entityId: "1", version: 1, serverVersion: 11, deviceId: "device-b", payload: AnyCodable(["id":"1"]), updatedAt: "now", deletedAt: nil)
        let res = PushResult(mutationId: "m1", accepted: true, serverVersion: 11, replayMismatch: nil, serverMissing: nil, conflictId: nil, record: rec)
        XCTAssertThrowsError(try applyPushResults(meta, batch: [m], results: [res]))
    }
    func test_serverVersion_zero_when_accepted_throws() {
        var meta = emptySyncMeta()
        let m = SyncMutation(mutationId: "m1", deviceId: "d", entityType: "tasks", entityId: "1", baseServerVersion: nil, version: 1, payload: AnyCodable(["id":"1"]), updatedAt: "now", deletedAt: nil, dependsOnMutationId: nil, resolvesConflictId: nil, attemptedAt: nil)
        meta.outbox = [m]
        let rec = RemoteRecord(entityType: "tasks", entityId: "1", version: 1, serverVersion: 0, deviceId: "d", payload: AnyCodable(["id":"1"]), updatedAt: "now", deletedAt: nil)
        let res = PushResult(mutationId: "m1", accepted: true, serverVersion: 0, replayMismatch: nil, serverMissing: nil, conflictId: nil, record: rec)
        XCTAssertThrowsError(try applyPushResults(meta, batch: [m], results: [res]))
    }
    func test_replayMismatch_throws() {
        var meta = emptySyncMeta()
        let m = SyncMutation(mutationId: "m1", deviceId: "d", entityType: "tasks", entityId: "1", baseServerVersion: nil, version: 1, payload: AnyCodable(["id":"1"]), updatedAt: "now", deletedAt: nil, dependsOnMutationId: nil, resolvesConflictId: nil, attemptedAt: nil)
        meta.outbox = [m]
        let rec = RemoteRecord(entityType: "tasks", entityId: "1", version: 1, serverVersion: 11, deviceId: "d", payload: AnyCodable(["id":"1"]), updatedAt: "now", deletedAt: nil)
        let res = PushResult(mutationId: "m1", accepted: true, serverVersion: 11, replayMismatch: true, serverMissing: nil, conflictId: nil, record: rec)
        XCTAssertThrowsError(try applyPushResults(meta, batch: [m], results: [res]))
    }
    func test_duplicate_ack_throws() {
        var meta = emptySyncMeta()
        let m1 = SyncMutation(mutationId: "m1", deviceId: "d", entityType: "tasks", entityId: "1", baseServerVersion: nil, version: 1, payload: AnyCodable(["id":"1"]), updatedAt: "now", deletedAt: nil, dependsOnMutationId: nil, resolvesConflictId: nil, attemptedAt: nil)
        let m2 = SyncMutation(mutationId: "m2", deviceId: "d", entityType: "tasks", entityId: "2", baseServerVersion: nil, version: 1, payload: AnyCodable(["id":"2"]), updatedAt: "now", deletedAt: nil, dependsOnMutationId: nil, resolvesConflictId: nil, attemptedAt: nil)
        meta.outbox = [m1, m2]
        let rec1 = RemoteRecord(entityType: "tasks", entityId: "1", version: 1, serverVersion: 11, deviceId: "d", payload: AnyCodable(["id":"1"]), updatedAt: "now", deletedAt: nil)
        let res1 = PushResult(mutationId: "m1", accepted: true, serverVersion: 11, replayMismatch: nil, serverMissing: nil, conflictId: nil, record: rec1)
        // Duplicate m1 twice
        XCTAssertThrowsError(try applyPushResults(meta, batch: [m1,m2], results: [res1,res1]))
    }
    func test_exact_ack_required() {
        var meta = emptySyncMeta()
        let m = SyncMutation(mutationId: "m1", deviceId: "d", entityType: "tasks", entityId: "1", baseServerVersion: nil, version: 1, payload: AnyCodable(["id":"1"]), updatedAt: "now", deletedAt: nil, dependsOnMutationId: nil, resolvesConflictId: nil, attemptedAt: nil)
        meta.outbox = [m]
        let rec = RemoteRecord(entityType: "tasks", entityId: "1", version: 1, serverVersion: 11, deviceId: "d", payload: AnyCodable(["id":"1"]), updatedAt: "now", deletedAt: nil)
        let res = PushResult(mutationId: "m1", accepted: true, serverVersion: 11, replayMismatch: nil, serverMissing: nil, conflictId: nil, record: rec)
        // Batch 1 but results empty
        XCTAssertThrowsError(try applyPushResults(meta, batch: [m], results: []))
    }

    func test_rejected_resolution_replaces_old_conflict_without_losing_history() throws {
        let originalMutationId = "11111111-1111-4111-8111-111111111111"
        let resolutionMutationId = "22222222-2222-4222-8222-222222222222"
        let originalConflictId = "33333333-3333-4333-8333-333333333333"
        let replacementConflictId = "44444444-4444-4444-8444-444444444444"
        var meta = emptySyncMeta()
        meta.conflicts = [LocalConflict(
            id: originalConflictId,
            entityType: "tasks",
            entityId: "task-1",
            mutationId: originalMutationId,
            baseServerVersion: 1,
            serverVersion: 2,
            localPayload: AnyCodable(["id": "task-1", "title": "First local"]),
            localDeletedAt: nil,
            localHistory: [AnyCodable([
                "mutationId": originalMutationId,
                "payload": ["id": "task-1", "title": "First local"],
                "deletedAt": NSNull(),
                "updatedAt": "2026-09-03T00:00:00.000Z",
                "version": 2
            ])],
            serverPayload: AnyCodable(["id": "task-1", "title": "First cloud"]),
            serverMissing: false,
            serverDeletedAt: nil,
            status: "resolving-local",
            createdAt: "2026-09-03T00:00:01.000Z"
        )]
        let resolution = SyncMutation(
            mutationId: resolutionMutationId,
            deviceId: "device-a",
            entityType: "tasks",
            entityId: "task-1",
            baseServerVersion: 2,
            version: 3,
            payload: AnyCodable(["id": "task-1", "title": "Latest local"]),
            updatedAt: "2026-09-03T00:00:02.000Z",
            deletedAt: nil,
            dependsOnMutationId: nil,
            resolvesConflictId: originalConflictId,
            attemptedAt: nil
        )
        meta.outbox = [resolution]
        let serverRecord = RemoteRecord(
            entityType: "tasks",
            entityId: "task-1",
            version: 4,
            serverVersion: 3,
            deviceId: "device-b",
            payload: AnyCodable(["id": "task-1", "title": "New cloud"]),
            updatedAt: "2026-09-03T00:00:03.000Z",
            deletedAt: nil
        )
        let result = PushResult(
            mutationId: resolutionMutationId,
            accepted: false,
            serverVersion: 3,
            replayMismatch: false,
            serverMissing: false,
            conflictId: replacementConflictId,
            record: serverRecord
        )

        let next = try applyPushResults(meta, batch: [resolution], results: [result])

        XCTAssertTrue(next.outbox.isEmpty)
        XCTAssertEqual(next.conflicts.map(\.id), [replacementConflictId])
        let historyIds = next.conflicts[0].localHistory.compactMap {
            ($0.value as? [String: Any])?["mutationId"] as? String
        }
        XCTAssertEqual(historyIds, [originalMutationId, resolutionMutationId])
        XCTAssertEqual(stableJson(next.conflicts[0].localPayload.value), "{\"id\":\"task-1\",\"title\":\"Latest local\"}")
        XCTAssertEqual(stableJson(next.conflicts[0].serverPayload.value), "{\"id\":\"task-1\",\"title\":\"New cloud\"}")
    }
}

final class ApplyRemotePageTests: XCTestCase {
    func test_cursor_moved_backwards_throws() {
        var meta = emptySyncMeta()
        meta.cursor = 5
        XCTAssertThrowsError(try applyRemotePage(meta, currentValues: [:], records: [], nextCursor: 4, ownDeviceId: "d", now: "now"))
    }
    func test_stale_serverVersion_throws() {
        var meta = emptySyncMeta()
        meta.cursor = 5
        let rec = RemoteRecord(entityType: "tasks", entityId: "1", version: 1, serverVersion: 3, deviceId: "o", payload: AnyCodable(["id":"1"]), updatedAt: "now", deletedAt: nil)
        XCTAssertThrowsError(try applyRemotePage(meta, currentValues: [:], records: [rec], nextCursor: 3, ownDeviceId: "d", now: "now"))
    }
    func test_duplicate_serverVersion_throws() {
        var meta = emptySyncMeta()
        let r1 = RemoteRecord(entityType: "tasks", entityId: "1", version: 1, serverVersion: 1, deviceId: "o", payload: AnyCodable(["id":"1"]), updatedAt: "now", deletedAt: nil)
        let r2 = RemoteRecord(entityType: "tasks", entityId: "2", version: 1, serverVersion: 1, deviceId: "o", payload: AnyCodable(["id":"2"]), updatedAt: "now", deletedAt: nil)
        XCTAssertThrowsError(try applyRemotePage(meta, currentValues: [:], records: [r1,r2], nextCursor: 1, ownDeviceId: "d", now: "now"))
    }
    func test_skip_throws() {
        var meta = emptySyncMeta()
        let r = RemoteRecord(entityType: "tasks", entityId: "1", version: 1, serverVersion: 5, deviceId: "o", payload: AnyCodable(["id":"1"]), updatedAt: "now", deletedAt: nil)
        XCTAssertThrowsError(try applyRemotePage(meta, currentValues: [:], records: [r], nextCursor: 10, ownDeviceId: "d", now: "now"))
    }
    func test_pull_creates_conflict_when_pending() throws {
        var meta = emptySyncMeta()
        let m = SyncMutation(mutationId: "m1", deviceId: "d", entityType: "tasks", entityId: "1", baseServerVersion: nil, version: 1, payload: AnyCodable(["id":"1","title":"Local"]), updatedAt: "now", deletedAt: nil, dependsOnMutationId: nil, resolvesConflictId: nil, attemptedAt: nil)
        meta.outbox = [m]
        meta.versions[syncEntityKey("tasks","1")] = VersionPair(local: 1, server: nil)
        let rec = RemoteRecord(entityType: "tasks", entityId: "1", version: 1, serverVersion: 1, deviceId: "other", payload: AnyCodable(["id":"1","title":"Remote"]), updatedAt: "now", deletedAt: nil)
        let res = try applyRemotePage(meta, currentValues: [:], records: [rec], nextCursor: 1, ownDeviceId: "d", now: "now")
        XCTAssertFalse(res.meta.conflicts.isEmpty)
        XCTAssertTrue(res.meta.outbox.isEmpty) // pending removed
        XCTAssertEqual(res.meta.cursor, 1)
    }
    func test_upsert_when_no_pending() throws {
        var meta = emptySyncMeta()
        let updatedAt = "2026-09-03T12:00:00.000Z"
        let rec = RemoteRecord(entityType: "tasks", entityId: "1", version: 1, serverVersion: 1, deviceId: "other", payload: AnyCodable(["id":"1","title":"Remote"]), updatedAt: updatedAt, deletedAt: nil)
        let res = try applyRemotePage(meta, currentValues: [:], records: [rec], nextCursor: 1, ownDeviceId: "d", now: "now")
        XCTAssertTrue(res.meta.conflicts.isEmpty)
        XCTAssertEqual(
            stableJson(res.values["tasks"]),
            stableJson([["id":"1","title":"Remote","updatedAt":updatedAt,"version":1] as [String: Any]])
        )
    }
}

final class ServerConflictTests: XCTestCase {
    private let conflictId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
    private let mutationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2"

    private func remoteConflict(localTitle: String = "Local", serverTitle: String = "Cloud") -> [String: Any] {
        [
            "id": conflictId,
            "entity_type": "tasks",
            "entity_id": "task-1",
            "mutation_id": mutationId,
            "base_server_version": 4,
            "local_payload": ["id": "task-1", "title": localTitle],
            "local_deleted_at": NSNull(),
            "local_version": 5,
            "local_updated_at": "2026-09-03T00:00:00.000Z",
            "server_payload": ["id": "task-1", "title": serverTitle],
            "server_deleted_at": NSNull(),
            "server_version": 6,
            "server_missing": false,
            "created_at": "2026-09-03T00:00:01.000Z"
        ]
    }

    func test_snake_case_server_conflict_imports_both_sides() throws {
        let parsed = try parseServerConflictSet([remoteConflict()])
        let merged = try mergeServerConflicts(emptySyncMeta(), conflicts: parsed)

        let conflict = try XCTUnwrap(merged.conflicts.first)
        XCTAssertEqual(conflict.id, conflictId)
        XCTAssertEqual(conflict.mutationId, mutationId)
        XCTAssertEqual(stableJson(conflict.localPayload.value), "{\"id\":\"task-1\",\"title\":\"Local\"}")
        XCTAssertEqual(stableJson(conflict.serverPayload.value), "{\"id\":\"task-1\",\"title\":\"Cloud\"}")
        XCTAssertEqual(merged.versions[syncEntityKey("tasks", "task-1")], VersionPair(local: 5, server: 6))
    }

    func test_server_conflict_replay_cannot_change_preserved_local_data() throws {
        let first = try mergeServerConflicts(
            emptySyncMeta(),
            conflicts: parseServerConflictSet([remoteConflict()])
        )
        XCTAssertThrowsError(try mergeServerConflicts(
            first,
            conflicts: parseServerConflictSet([remoteConflict(localTitle: "Different")])
        ))
        XCTAssertEqual(stableJson(first.conflicts.first?.localPayload.value), "{\"id\":\"task-1\",\"title\":\"Local\"}")
    }

    func test_sync_imports_postgresql_only_conflict_before_success() async throws {
        let suite = "goalflow.sync.server-conflict.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let transport = MockSyncTransport()
        transport.pullHandler = { _ in
            let data = try JSONSerialization.data(withJSONObject: ["records": [], "nextCursor": 0, "hasMore": false])
            return (data, HTTPURLResponse(url: URL(string: "https://example.com")!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        transport.conflictHandler = { _, method, _ in
            XCTAssertEqual(method, "GET")
            let data = try JSONSerialization.data(withJSONObject: ["conflicts": [self.remoteConflict()]])
            return (data, HTTPURLResponse(url: URL(string: "https://example.com")!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        let metaStore = SyncMetaStore(fileURL: directory.appendingPathComponent("sync.json"), defaults: defaults)
        let engine = SyncEngine(
            metaStore: metaStore,
            deviceIdStore: DeviceIdStore(defaults: defaults),
            transport: transport,
            storeBridge: FileSyncStoreBridge(baseDir: directory, defaults: defaults)
        )
        try await engine.bindLocalWorkspace(to: MockSyncTransport.defaultUserId)

        try await engine.synchronize()

        let meta = try metaStore.load()
        XCTAssertEqual(meta.conflicts.map(\.id), [conflictId])
        XCTAssertNotNil(meta.lastSuccessfulSync)
    }

    func test_cloud_resolution_without_exact_ack_preserves_local_and_cloud_sides() async throws {
        let suite = "goalflow.sync.resolve-failure.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let metaStore = SyncMetaStore(fileURL: directory.appendingPathComponent("sync.json"), defaults: defaults)
        let bridge = FileSyncStoreBridge(baseDir: directory, defaults: defaults)
        let localTask = GoalflowTask(id: "task-1", title: "Local", scheduledFor: "2026-09-03")
        try bridge.saveValues(["tasks": [try localTask.toDictionary()]])
        var meta = try metaStore.load()
        meta.accountUserId = MockSyncTransport.defaultUserId
        meta.conflicts = try mergeServerConflicts(
            emptySyncMeta(),
            conflicts: parseServerConflictSet([remoteConflict()])
        ).conflicts
        try metaStore.save(meta)
        let transport = MockSyncTransport()
        transport.conflictHandler = { path, method, body in
            XCTAssertTrue(path.hasSuffix("/resolve"))
            XCTAssertEqual(method, "POST")
            let submitted = try XCTUnwrap(
                JSONSerialization.jsonObject(with: XCTUnwrap(body)) as? [String: Any]
            )
            XCTAssertEqual(submitted["conflictId"] as? String, self.conflictId)
            XCTAssertEqual(submitted["mutationId"] as? String, self.mutationId)
            let data = try JSONSerialization.data(withJSONObject: [
                "resolved": true,
                "conflictId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                "mutationId": self.mutationId
            ])
            return (data, HTTPURLResponse(url: URL(string: "https://example.com")!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        let engine = SyncEngine(
            metaStore: metaStore,
            deviceIdStore: DeviceIdStore(defaults: defaults),
            transport: transport,
            storeBridge: bridge,
            retrySleeper: { _ in XCTFail("A permanent conflict rejection must not retry.") },
            retryJitter: { _ in 0 }
        )

        do {
            try await engine.resolveConflict(id: self.conflictId, useLocal: false)
            XCTFail("A rejected server resolution must not be reported as successful.")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("exact conflict"))
        }
        XCTAssertEqual(try metaStore.load().conflicts.map(\.id), [conflictId])
        let stored = try XCTUnwrap((try bridge.loadValues()["tasks"] as? [[String: Any]])?.first)
        XCTAssertEqual(stored["title"] as? String, "Local")
    }
}

final class ChaosTests: XCTestCase {
    func test_chaos_20_sequences() throws {
        var meta = emptySyncMeta()
        let device = "device1"
        for i in 0..<20 {
            let prev: [[String: Any]] = (0..<i).map { ["id":"\($0)","title":"T\($0)"] }
            let next: [[String: Any]] = (0...i).map { ["id":"\($0)","title":"T\($0)"] }
            if let tx = try buildStagedLocalTransaction(storeName: "tasks", userKey: "u", previousValue: prev, nextValue: next, order: i, now: "2026-09-01T00:00:00Z", randomUuid: { UUID().uuidString }) {
                meta = try appendStagedTransactions(meta, transactions: [tx], deviceId: device)
                let ready = readyOutbox(meta, limit: 50)
                if let first = ready.first {
                    let rec = RemoteRecord(entityType: first.entityType, entityId: first.entityId, version: first.version, serverVersion: i+1, deviceId: device, payload: first.payload, updatedAt: first.updatedAt, deletedAt: first.deletedAt)
                    let res = PushResult(mutationId: first.mutationId, accepted: true, serverVersion: i+1, replayMismatch: nil, serverMissing: nil, conflictId: nil, record: rec)
                    meta = try applyPushResults(meta, batch: [first], results: [res])
                }
            }
        }
        // Should not throw and cursor still 0 (no pull) but outbox may have pending
        XCTAssertNotNil(meta)
    }
}

final class TwoDeviceTests: XCTestCase {
    func test_completed_never_resurrects() throws {
        // Device A completes offline
        var metaA = emptySyncMeta()
        let taskId = "t1"
        let prev: [[String: Any]] = [["id":taskId,"title":"Task","status":"open"]]
        let next: [[String: Any]] = [["id":taskId,"title":"Task","status":"completed","completedAt":"now"]]
        let tx = try buildStagedLocalTransaction(storeName: "tasks", userKey: "u", previousValue: prev, nextValue: next, order: 1, now: "now", randomUuid: { "m1" })!
        metaA = try appendStagedTransactions(metaA, transactions: [tx], deviceId: "A")
        XCTAssertEqual(metaA.outbox.count, 1)
        // Pull remote open from B should create conflict, not resurrect
        let rec = RemoteRecord(entityType: "tasks", entityId: taskId, version: 1, serverVersion: 1, deviceId: "B", payload: AnyCodable(["id":taskId,"title":"Task","status":"open"]), updatedAt: "now", deletedAt: nil)
        let res = try applyRemotePage(metaA, currentValues: ["tasks": next], records: [rec], nextCursor: 1, ownDeviceId: "A", now: "now")
        XCTAssertFalse(res.meta.conflicts.isEmpty)
        // Cursor advances even with conflict
        XCTAssertEqual(res.meta.cursor, 1)
        // Outbox cleared (conflict)
        XCTAssertTrue(res.meta.outbox.isEmpty)
    }
    func test_conflict_keep_local_vs_cloud() throws {
        var meta = emptySyncMeta()
        // Create pending
        let prev: [[String: Any]] = [["id":"1","title":"Local"]]
        let next: [[String: Any]] = [["id":"1","title":"EditedLocal"]]
        let tx = try buildStagedLocalTransaction(storeName: "tasks", userKey: "u", previousValue: prev, nextValue: next, order: 1, now: "now", randomUuid: { "m1" })!
        meta = try appendStagedTransactions(meta, transactions: [tx], deviceId: "d")
        // Remote different title
        let rec = RemoteRecord(entityType: "tasks", entityId: "1", version: 1, serverVersion: 1, deviceId: "other", payload: AnyCodable(["id":"1","title":"Remote"]), updatedAt: "now", deletedAt: nil)
        let res = try applyRemotePage(meta, currentValues: [:], records: [rec], nextCursor: 1, ownDeviceId: "d", now: "now")
        XCTAssertEqual(res.meta.conflicts.count, 1)
        let conflict = res.meta.conflicts.first!
        // Keep local: create retry mutation with baseServerVersion = conflict.serverVersion
        var meta2 = res.meta
        // Simulate resolve local
        let retryId = UUID().uuidString
        let retry = SyncMutation(mutationId: retryId, deviceId: "d", entityType: "tasks", entityId: "1", baseServerVersion: conflict.serverVersion, version: 2, payload: conflict.localPayload, updatedAt: "now", deletedAt: conflict.localDeletedAt, dependsOnMutationId: nil, resolvesConflictId: conflict.id, attemptedAt: nil)
        meta2.outbox.append(retry)
        XCTAssertEqual(retry.baseServerVersion, 1)
    }
}

final class HostedCrossClientSyncTests: XCTestCase {
    func testProductionTransportEditsAndroidRecord() async throws {
        let runtime = try hostedRuntime()
        guard try hostedEnvironment("GOALFLOW_HOSTED_TEST_CONFIRM", from: runtime) == "staging",
              try hostedEnvironment("GOALFLOW_CROSS_CLIENT_PHASE", from: runtime) == "macos" else {
            throw SyncError.validation("The macOS hosted runtime is not the explicit staging cross-client gate.")
        }
        let state = try hostedState(runtime: runtime)
        let taskId = try XCTUnwrap(state["taskId"] as? String)
        let androidTitle = try XCTUnwrap(state["androidTitle"] as? String)
        let macosTitle = try XCTUnwrap(state["macosTitle"] as? String)
        XCTAssertNotNil(UUID(uuidString: taskId))

        let appOrigin = try hostedOrigin("GOALFLOW_STAGING_APP_ORIGIN", from: runtime)
        let supabaseOrigin = try hostedOrigin("GOALFLOW_STAGING_SUPABASE_URL", from: runtime)
        let publishableKey = try hostedEnvironment("GOALFLOW_STAGING_SUPABASE_PUBLISHABLE_KEY", from: runtime)
        XCTAssertTrue(publishableKey.hasPrefix("sb_publishable_"), "A server credential must never enter the native gate.")
        let configuration = MacCloudConfiguration(
            apiOrigin: appOrigin,
            supabaseURL: supabaseOrigin,
            publishableKey: publishableKey,
            environment: "staging"
        )
        XCTAssertTrue(configuration.isCloudConfigured, configuration.problem ?? "Cloud configuration was rejected.")

        let urlConfiguration = URLSessionConfiguration.ephemeral
        urlConfiguration.timeoutIntervalForRequest = 20
        urlConfiguration.timeoutIntervalForResource = 25
        let urlSession = URLSession(configuration: urlConfiguration)
        let expectedUserId = try hostedEnvironment("GOALFLOW_STAGING_USER_A_ID", from: runtime).lowercased()
        let session = try await hostedPasswordSession(
            configuration: configuration,
            publishableKey: publishableKey,
            expectedUserId: expectedUserId,
            urlSession: urlSession,
            runtime: runtime
        )
        XCTAssertEqual(session.userId, expectedUserId)

        // This transport gate is intentionally unsigned in CI, so macOS will reject the
        // Data Protection Keychain with errSecMissingEntitlement. Share only the injected
        // test backend across fresh store instances here; signed-artifact Keychain proof
        // remains a separate release gate.
        let keychainBackend = KeychainMemoryBackend()
        let keychainService = "tsurfing.hosted-test.\(UUID().uuidString.lowercased())"
        let keychain = KeychainSessionStore(
            service: keychainService,
            memoryBackend: keychainBackend
        )
        defer { try? keychain.clear() }
        try keychain.save(session)
        let restartedKeychain = KeychainSessionStore(
            service: keychainService,
            memoryBackend: keychainBackend
        )
        XCTAssertEqual(try restartedKeychain.read(), session)

        let suite = "goalflow.hosted-cross-client.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let metaStore = SyncMetaStore(fileURL: directory.appendingPathComponent("sync.json"), defaults: defaults)
        let deviceIdStore = DeviceIdStore(defaults: defaults)
        let bridge = FileSyncStoreBridge(baseDir: directory, defaults: defaults)
        let taskStore = LocalTaskStore(
            fileURL: directory.appendingPathComponent("goalflow.tasks.json"),
            defaults: defaults,
            syncMetaStore: metaStore,
            deviceIdStore: deviceIdStore
        )
        let engine = SyncEngine(
            metaStore: metaStore,
            deviceIdStore: deviceIdStore,
            transport: URLSessionSyncTransport(
                configuration: configuration,
                keychain: restartedKeychain,
                urlSession: urlSession
            ),
            storeBridge: bridge
        )

        try await engine.bindLocalWorkspace(to: expectedUserId)
        try await engine.synchronize()
        var task = try XCTUnwrap(try taskStore.loadAll().first { $0.id == taskId })
        XCTAssertEqual(task.title, androidTitle)
        let key = syncEntityKey("tasks", taskId)
        let pulledMeta = try metaStore.load()
        let beforeServerVersion = try XCTUnwrap(
            pulledMeta.versions[key]?.server,
            "The macOS gate must observe the Android server version before editing."
        )
        XCTAssertFalse(pulledMeta.outbox.contains { $0.entityType == "tasks" && $0.entityId == taskId })
        XCTAssertFalse(pulledMeta.conflicts.contains { $0.entityType == "tasks" && $0.entityId == taskId })

        task.title = macosTitle
        task.updatedAt = ISO8601DateFormatter().string(from: Date())
        task.version += 1
        try taskStore.updateTask(task)
        let pending = try metaStore.load().outbox.filter { $0.entityType == "tasks" && $0.entityId == taskId }
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual((pending.first?.payload.value as? [String: Any])?["title"] as? String, macosTitle)

        try await engine.synchronize()
        let committedMeta = try metaStore.load()
        XCTAssertFalse(committedMeta.outbox.contains { $0.entityType == "tasks" && $0.entityId == taskId })
        XCTAssertFalse(committedMeta.conflicts.contains { $0.entityType == "tasks" && $0.entityId == taskId })
        let afterServerVersion = try XCTUnwrap(
            committedMeta.versions[key]?.server,
            "The macOS mutation must receive an authoritative server version."
        )
        XCTAssertGreaterThan(afterServerVersion, beforeServerVersion)
        XCTAssertEqual(try taskStore.loadAll().first { $0.id == taskId }?.title, macosTitle)
        XCTAssertNotNil(committedMeta.lastSuccessfulSync)
        try writeHostedProof(
            taskId: taskId,
            title: macosTitle,
            beforeServerVersion: beforeServerVersion,
            afterServerVersion: afterServerVersion,
            runtime: runtime
        )
    }

    private func hostedPasswordSession(
        configuration: MacCloudConfiguration,
        publishableKey: String,
        expectedUserId: String,
        urlSession: URLSession,
        runtime: [String: String]
    ) async throws -> NativeSession {
        let supabaseURL = try XCTUnwrap(configuration.supabaseURL)
        var components = try XCTUnwrap(URLComponents(url: supabaseURL, resolvingAgainstBaseURL: false))
        components.path = "/auth/v1/token"
        components.queryItems = [URLQueryItem(name: "grant_type", value: "password")]
        var request = URLRequest(url: try XCTUnwrap(components.url))
        request.httpMethod = "POST"
        request.setValue(publishableKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(publishableKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "email": try hostedEnvironment("GOALFLOW_STAGING_USER_A_EMAIL", from: runtime),
            "password": try hostedEnvironment("GOALFLOW_STAGING_USER_A_PASSWORD", from: runtime)
        ])
        let (data, response) = try await urlSession.data(for: request)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        guard http.statusCode == 200 else {
            throw SyncError.validation("Staging password authentication failed with HTTP \(http.statusCode).")
        }
        guard data.count <= 1024 * 1024 else {
            throw SyncError.validation("Staging authentication returned an unsafe response size.")
        }
        return try parseNativeSessionResponse(
            data,
            configuration: configuration,
            expectedUserId: expectedUserId
        )
    }

    private func hostedRuntime() throws -> [String: String] {
        let url = URL(fileURLWithPath: "/tmp/tsurfing-hosted-cross-client-macos.json")
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw XCTSkip("The live transport proof runs only inside the explicit staging cross-client gate.")
        }
        let data = try Data(contentsOf: url)
        guard data.count <= 64 * 1024,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["schemaVersion"] as? Int == 1,
              let runtime = object["environment"] as? [String: String] else {
            throw SyncError.validation("The macOS hosted runtime configuration is invalid.")
        }
        return runtime
    }

    private func hostedState(runtime: [String: String]) throws -> [String: Any] {
        let path = try hostedEnvironment("GOALFLOW_CROSS_CLIENT_STATE_FILE", from: runtime)
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        guard data.count <= 16 * 1024,
              let state = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              state["schemaVersion"] as? Int == 1 else {
            throw SyncError.validation("The cross-client handoff state is invalid.")
        }
        return state
    }

    private func hostedEnvironment(_ name: String, from runtime: [String: String]) throws -> String {
        guard let value = runtime[name]?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            throw SyncError.validation("Missing required hosted staging setting: \(name)")
        }
        return value
    }

    private func hostedOrigin(_ name: String, from runtime: [String: String]) throws -> String {
        let value = try hostedEnvironment(name, from: runtime).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let components = URLComponents(string: value),
              components.scheme == "https", components.host?.isEmpty == false,
              components.user == nil, components.password == nil,
              components.path.isEmpty, components.query == nil, components.fragment == nil else {
            throw SyncError.validation("Hosted staging setting \(name) must be a credential-free HTTPS origin.")
        }
        return value
    }

    private func writeHostedProof(
        taskId: String,
        title: String,
        beforeServerVersion: Int,
        afterServerVersion: Int,
        runtime: [String: String]
    ) throws {
        let path = try hostedEnvironment("GOALFLOW_CROSS_CLIENT_MACOS_PROOF_FILE", from: runtime)
        let payload: [String: Any] = [
            "schemaVersion": 1,
            "taskId": taskId,
            "title": title,
            "beforeServerVersion": beforeServerVersion,
            "afterServerVersion": afterServerVersion
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        try data.write(to: URL(fileURLWithPath: path), options: [.atomic])
    }
}
