import XCTest
import ImageIO
@testable import GoalflowMac

private actor SyncRetryProbe {
    private var attempts = 0
    private var delays: [UInt64] = []

    func nextAttempt() -> Int {
        attempts += 1
        return attempts
    }

    func recordDelay(_ nanoseconds: UInt64) {
        delays.append(nanoseconds)
    }

    func snapshot() -> (attempts: Int, delays: [UInt64]) {
        (attempts, delays)
    }
}

final class HardeningTests: XCTestCase {
    private var repositoryRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // GoalflowMacTests
            .deletingLastPathComponent() // macos-native
            .deletingLastPathComponent() // repository root
    }

    private func repositoryFile(_ path: String) -> URL {
        repositoryRoot.appendingPathComponent(path)
    }

    func test_entitlements_file_exists_and_contains_keys() throws {
        let url = repositoryFile("macos-native/GoalflowMac/GoalflowMac.entitlements")
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), "Entitlements file missing")
        let data = try Data(contentsOf: url)
        let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        XCTAssertNotNil(plist?["com.apple.security.app-sandbox"])
        XCTAssertNotNil(plist?["com.apple.security.network.client"])
    }

    func test_privacy_manifest_exists() throws {
        let url = repositoryFile("macos-native/GoalflowMac/Resources/PrivacyInfo.xcprivacy")
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), "PrivacyInfo.xcprivacy missing")
        let data = try Data(contentsOf: url)
        let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        XCTAssertEqual(plist?["NSPrivacyTracking"] as? Bool, false)
    }

    func test_su_feed_url_exists() throws {
        let url = repositoryFile("macos-native/GoalflowMac/Resources/Info.plist")
        let data = try Data(contentsOf: url)
        let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        XCTAssertEqual(plist?["SUFeedURL"] as? String, "https://app.tsurfing.com/appcast.xml")
        XCTAssertEqual(plist?["CFBundleShortVersionString"] as? String, "$(MARKETING_VERSION)")
        XCTAssertEqual(plist?["CFBundleVersion"] as? String, "$(CURRENT_PROJECT_VERSION)")
    }

    func test_app_icon_exists() throws {
        let directory = repositoryFile("macos-native/GoalflowMac/Resources/Assets.xcassets/AppIcon.appiconset")
        let data = try Data(contentsOf: directory.appendingPathComponent("Contents.json"))
        let contents = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let images = try XCTUnwrap(contents["images"] as? [[String: Any]])
        XCTAssertEqual(images.count, 10)

        let expectedDimensions = [
            "AppIcon-16.png": 16,
            "AppIcon-32.png": 32,
            "AppIcon-64.png": 64,
            "AppIcon-128.png": 128,
            "AppIcon-256.png": 256,
            "AppIcon.png": 512,
            "AppIcon@2x.png": 1024
        ]
        XCTAssertEqual(Set(images.compactMap { $0["filename"] as? String }), Set(expectedDimensions.keys))
        for (filename, expectedDimension) in expectedDimensions {
            let iconURL = directory.appendingPathComponent(filename)
            let source = try XCTUnwrap(CGImageSourceCreateWithURL(iconURL as CFURL, nil), "Missing or unreadable \(filename)")
            let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
            XCTAssertEqual(properties[kCGImagePropertyPixelWidth] as? Int, expectedDimension, filename)
            XCTAssertEqual(properties[kCGImagePropertyPixelHeight] as? Int, expectedDimension, filename)
        }
    }

    func test_store_bridge_all_shared_stores() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let bridge = FileSyncStoreBridge(baseDir: tmp, defaults: UserDefaults(suiteName: UUID().uuidString)!)
        // Write every shared store via the same durable bridge.
        let task = try GoalflowTask(id: "1", title: "T", scheduledFor: "2026-09-01").toDictionary()
        let values: [String: Any] = [
            "tasks": [task],
            "goals": [["id":"g1","name":"G","color":"#4F46E5","createdAt":0]],
            "habits": [["id":"h1"]],
            "truenorth": [["id":"tn1","vision":"V","isMoneyGoal":false,"sensoryDetails":"","planB":"","importance":1,"createdAt":0]],
            "daily_plans": [["id":"2026-09-01","localDate":"2026-09-01","confirmedAt":"now","taskIds":[]]],
            "stats": ["tasksCompleted":1],
            "progress": ["level":1],
            "hashtags": ["tag":"value"],
            "accountability": ["enabled":true],
            "amalgam": "hello",
            "tracking": ["t":1],
            "circadian": ["score":50],
            "settings": ["theme":"dark"],
            "task_events": [[
                "id": "11111111-1111-4111-8111-111111111111",
                "taskId": "22222222-2222-4222-8222-222222222222",
                "eventType": "completed",
                "localDate": "2026-09-01",
                "metadata": [String: Any](),
                "createdAt": "2026-09-01T10:00:00.000Z"
            ]]
        ]
        try bridge.saveValues(values)
        let loaded = try bridge.loadValues()
        XCTAssertNotNil(loaded["tasks"])
        XCTAssertNotNil(loaded["habits"])
        XCTAssertNotNil(loaded["truenorth"])
        XCTAssertNotNil(loaded["stats"])
        XCTAssertNotNil(loaded["settings"])
        XCTAssertNotNil(loaded["task_events"])
    }

    func test_store_bridge_normalizes_browser_task_shape_for_native_use() throws {
        let suite = "goalflow.bridge.web-task.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let bridge = FileSyncStoreBridge(baseDir: tmp, defaults: defaults)
        try bridge.saveValues(["tasks": [[
            "id": "shared-task",
            "title": "From browser",
            "description": "Preserved notes",
            "completed": false,
            "isFrog": false,
            "createdAt": 1_788_393_600_000,
            "updatedAt": 1_788_393_600_000,
            "duration": 30,
            "hashtags": ["shared"],
            "dateAssigned": "2026-09-03",
            "schedulePrecision": "day",
            "version": 4
        ]]])

        let taskStore = LocalTaskStore(
            fileURL: tmp.appendingPathComponent("goalflow.tasks.json"),
            defaults: defaults,
            syncMetaStore: SyncMetaStore(fileURL: tmp.appendingPathComponent("sync.json"), defaults: defaults),
            deviceIdStore: DeviceIdStore(defaults: defaults)
        )
        let task = try XCTUnwrap(taskStore.loadAll().first)
        XCTAssertEqual(task.title, "From browser")
        XCTAssertEqual(task.notes, "Preserved notes")
        XCTAssertEqual(task.tags, ["shared"])
        XCTAssertEqual(task.durationMinutes, 30)
        XCTAssertEqual(task.version, 4)
    }

    func test_store_bridge_deletes_singleton_replica() throws {
        let suite = "goalflow.bridge.delete.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let bridge = FileSyncStoreBridge(baseDir: tmp, defaults: defaults)
        try bridge.saveValues(["amalgam": "keep then delete"])
        XCTAssertEqual(try bridge.loadValues()["amalgam"] as? String, "keep then delete")

        let writes = try bridge.preparedWrites([:], stores: ["amalgam"])
        let metaStore = SyncMetaStore(fileURL: tmp.appendingPathComponent("sync.json"), defaults: defaults)
        try metaStore.commitLocalValues(writes, nextMeta: metaStore.load())

        XCTAssertNil(try bridge.loadValues()["amalgam"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: tmp.appendingPathComponent("amalgam.json").path))
        XCTAssertNil(defaults.data(forKey: "goalflow.amalgam.v1"))
    }

    func test_store_bridge_rejects_malformed_task_before_write() throws {
        let suite = "goalflow.bridge.validation.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let bridge = FileSyncStoreBridge(baseDir: tmp, defaults: defaults)

        XCTAssertThrowsError(try bridge.preparedWrites(["tasks": [["id": "task-with-missing-fields"]]], stores: ["tasks"]))
        XCTAssertFalse(FileManager.default.fileExists(atPath: tmp.appendingPathComponent("goalflow.tasks.json").path))
    }

    func test_sync_engine_lock_serializes() async throws {
        let metaStore = SyncMetaStore(fileURL: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".json"), defaults: UserDefaults(suiteName: UUID().uuidString)!)
        let device = DeviceIdStore(defaults: UserDefaults(suiteName: UUID().uuidString)!)
        let transport = MockSyncTransport()
        transport.pushHandler = { _ in
            let data = try JSONSerialization.data(withJSONObject: ["results":[]])
            let resp = HTTPURLResponse(url: URL(string:"https://example.com")!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (data, resp)
        }
        transport.pullHandler = { _ in
            let data = try JSONSerialization.data(withJSONObject: ["records":[],"nextCursor":0,"hasMore":false])
            let resp = HTTPURLResponse(url: URL(string:"https://example.com")!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (data, resp)
        }
        let bridge = FileSyncStoreBridge(baseDir: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString), defaults: UserDefaults(suiteName: UUID().uuidString)!)
        let engine = SyncEngine(metaStore: metaStore, deviceIdStore: device, transport: transport, storeBridge: bridge)
        try await engine.bindLocalWorkspace(to: MockSyncTransport.defaultUserId)
        // Two concurrent synchronizes should not crash due to lock
        async let a: () = engine.synchronize()
        async let b: () = engine.synchronize()
        try await a
        try await b
        XCTAssertTrue(true)
    }

    func test_sync_retries_transient_status_with_capped_backoff() async throws {
        let suite = "goalflow.sync.retry.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let probe = SyncRetryProbe()
        let transport = MockSyncTransport()
        transport.pullHandler = { _ in
            let attempt = await probe.nextAttempt()
            let status = attempt < 3 ? 503 : 200
            let data = try JSONSerialization.data(withJSONObject: ["records": [], "nextCursor": 0, "hasMore": false])
            let response = HTTPURLResponse(url: URL(string: "https://example.com")!, statusCode: status, httpVersion: nil, headerFields: nil)!
            return (data, response)
        }
        let metaStore = SyncMetaStore(fileURL: directory.appendingPathComponent("sync.json"), defaults: defaults)
        let engine = SyncEngine(
            metaStore: metaStore,
            deviceIdStore: DeviceIdStore(defaults: defaults),
            transport: transport,
            storeBridge: FileSyncStoreBridge(baseDir: directory, defaults: defaults),
            retrySleeper: { await probe.recordDelay($0) },
            retryJitter: { _ in 0 }
        )
        try await engine.bindLocalWorkspace(to: MockSyncTransport.defaultUserId)

        try await engine.synchronize()

        let result = await probe.snapshot()
        XCTAssertEqual(result.attempts, 3)
        XCTAssertEqual(result.delays, [250_000_000, 500_000_000])
    }

    func test_sync_does_not_retry_permanent_validation_status() async throws {
        let suite = "goalflow.sync.no-retry.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let probe = SyncRetryProbe()
        let transport = MockSyncTransport()
        transport.pullHandler = { _ in
            _ = await probe.nextAttempt()
            let response = HTTPURLResponse(url: URL(string: "https://example.com")!, statusCode: 422, httpVersion: nil, headerFields: nil)!
            return (Data(), response)
        }
        let metaStore = SyncMetaStore(fileURL: directory.appendingPathComponent("sync.json"), defaults: defaults)
        let engine = SyncEngine(
            metaStore: metaStore,
            deviceIdStore: DeviceIdStore(defaults: defaults),
            transport: transport,
            storeBridge: FileSyncStoreBridge(baseDir: directory, defaults: defaults),
            retrySleeper: { await probe.recordDelay($0) },
            retryJitter: { _ in 0 }
        )
        try await engine.bindLocalWorkspace(to: MockSyncTransport.defaultUserId)

        do {
            try await engine.synchronize()
            XCTFail("A permanent validation response must fail synchronization.")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("422"))
        }
        let result = await probe.snapshot()
        XCTAssertEqual(result.attempts, 1)
        XCTAssertTrue(result.delays.isEmpty)
    }

    func test_sync_retries_timeout_without_changing_operation_identity() async throws {
        let suite = "goalflow.sync.timeout-retry.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let probe = SyncRetryProbe()
        let transport = MockSyncTransport()
        transport.pullHandler = { _ in
            let attempt = await probe.nextAttempt()
            if attempt == 1 { throw URLError(.timedOut) }
            let data = try JSONSerialization.data(withJSONObject: ["records": [], "nextCursor": 0, "hasMore": false])
            let response = HTTPURLResponse(url: URL(string: "https://example.com")!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (data, response)
        }
        let metaStore = SyncMetaStore(fileURL: directory.appendingPathComponent("sync.json"), defaults: defaults)
        let engine = SyncEngine(
            metaStore: metaStore,
            deviceIdStore: DeviceIdStore(defaults: defaults),
            transport: transport,
            storeBridge: FileSyncStoreBridge(baseDir: directory, defaults: defaults),
            retrySleeper: { await probe.recordDelay($0) },
            retryJitter: { _ in 0 }
        )
        try await engine.bindLocalWorkspace(to: MockSyncTransport.defaultUserId)

        try await engine.synchronize()

        let result = await probe.snapshot()
        XCTAssertEqual(result.attempts, 2)
        XCTAssertEqual(result.delays, [250_000_000])
    }

    func test_sync_rejects_fractional_pull_cursor_without_advancing() async throws {
        let suite = "goalflow.sync.fractional-cursor.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let transport = MockSyncTransport()
        transport.pullHandler = { _ in
            let data = try JSONSerialization.data(withJSONObject: [
                "records": [], "nextCursor": 0.5, "hasMore": false
            ])
            let response = HTTPURLResponse(
                url: URL(string: "https://example.com")!, statusCode: 200,
                httpVersion: nil, headerFields: nil
            )!
            return (data, response)
        }
        let metaStore = SyncMetaStore(fileURL: directory.appendingPathComponent("sync.json"), defaults: defaults)
        let engine = SyncEngine(
            metaStore: metaStore,
            deviceIdStore: DeviceIdStore(defaults: defaults),
            transport: transport,
            storeBridge: FileSyncStoreBridge(baseDir: directory, defaults: defaults)
        )
        try await engine.bindLocalWorkspace(to: MockSyncTransport.defaultUserId)

        do {
            try await engine.synchronize()
            XCTFail("A fractional cursor must not be coerced or committed.")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("cursor"))
        }
        let meta = try metaStore.load()
        XCTAssertEqual(meta.cursor, 0)
        XCTAssertNil(meta.lastSuccessfulSync)
    }

    func test_a11y_labels_exist() {
        // Check that ExecutionPanelView has accessibility identifiers via view inspection (static)
        // We can instantiate ViewModel and check that header has expected labels via View hierarchy is hard,
        // Instead check that the source file contains accessibilityLabel strings
        let url = repositoryFile("macos-native/GoalflowMac/UI/ExecutionPanelView.swift")
        let content = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        XCTAssertTrue(content.contains("accessibilityLabel(\"Start focus"))
        XCTAssertTrue(content.contains("accessibilityIdentifier(\"action-button\")"))
        XCTAssertTrue(content.contains("accessibilityLabel(\"Hold to complete"))
        XCTAssertTrue(content.contains("accessibilityLabel(\"Plan the day") || content.contains("gate-cta-button"))
    }

    func test_version_bump() throws {
        let url = repositoryFile("macos-native/GoalflowMac/Resources/Info.plist")
        let plist = try PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any]
        XCTAssertEqual(plist?["CFBundleShortVersionString"] as? String, "$(MARKETING_VERSION)")
    }

    func test_cloud_configuration_fails_closed_without_values() {
        let configuration = MacCloudConfiguration(info: [:])
        XCTAssertFalse(configuration.isCloudConfigured)
        XCTAssertNil(configuration.apiOrigin)
        XCTAssertNotNil(configuration.problem)
    }

    func test_cloud_configuration_rejects_server_secret_and_insecure_origin() {
        let serverSecret = ["sb", "secret", "must-never-be-in-a-client"].joined(separator: "_")
        let secretConfiguration = MacCloudConfiguration(
            apiOrigin: "https://app.tsurfing.test",
            supabaseURL: "https://project.supabase.co",
            publishableKey: serverSecret
        )
        XCTAssertFalse(secretConfiguration.isCloudConfigured)

        let insecureConfiguration = MacCloudConfiguration(
            apiOrigin: "http://app.tsurfing.test",
            supabaseURL: "https://project.supabase.co",
            publishableKey: "sb_publishable_tsurfing_test_only_value"
        )
        XCTAssertFalse(insecureConfiguration.isCloudConfigured)
    }

    func test_cloud_configuration_accepts_https_and_publishable_key() {
        let configuration = MacCloudConfiguration(
            apiOrigin: "https://app.tsurfing.test/",
            supabaseURL: "https://project.supabase.co/",
            publishableKey: "sb_publishable_tsurfing_test_only_value"
        )
        XCTAssertTrue(configuration.isCloudConfigured)
        XCTAssertEqual(configuration.apiOrigin?.absoluteString, "https://app.tsurfing.test")
        XCTAssertEqual(configuration.supabaseURL?.absoluteString, "https://project.supabase.co")
    }

    func test_cloud_configuration_allows_only_anon_legacy_jwt() throws {
        func legacyKey(role: String) throws -> String {
            let header = try JSONSerialization.data(withJSONObject: ["alg": "HS256", "typ": "JWT"])
            let payload = try JSONSerialization.data(withJSONObject: ["role": role])
            return [
                header.base64URLEncodedString(),
                payload.base64URLEncodedString(),
                "synthetic-signature"
            ].joined(separator: ".")
        }

        let anonConfiguration = MacCloudConfiguration(
            apiOrigin: "https://app.tsurfing.test",
            supabaseURL: "https://project.supabase.co",
            publishableKey: try legacyKey(role: "anon")
        )
        XCTAssertTrue(anonConfiguration.isCloudConfigured)

        let serverConfiguration = MacCloudConfiguration(
            apiOrigin: "https://app.tsurfing.test",
            supabaseURL: "https://project.supabase.co",
            publishableKey: try legacyKey(role: "service_role")
        )
        XCTAssertFalse(serverConfiguration.isCloudConfigured)
    }

    func test_auth_callback_requires_exact_custom_url() {
        XCTAssertTrue(SupabaseAuthService.isExpectedCallbackURL(URL(string: "tsurfing://auth/callback?code=one&state=two")!))
        XCTAssertFalse(SupabaseAuthService.isExpectedCallbackURL(URL(string: "tsurfing://auth/other?code=one&state=two")!))
        XCTAssertFalse(SupabaseAuthService.isExpectedCallbackURL(URL(string: "tsurfing://evil/callback?code=one&state=two")!))
        XCTAssertFalse(SupabaseAuthService.isExpectedCallbackURL(URL(string: "tsurfing://auth/callback?code=one#token")!))
    }

    func test_pkce_challenge_matches_rfc7636_vector() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        XCTAssertEqual(pkceChallenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func test_timing_safe_state_comparison_requires_exact_bytes() {
        XCTAssertTrue(timingSafeEqual("known-state", "known-state"))
        XCTAssertFalse(timingSafeEqual("known-state", "known-statf"))
        XCTAssertFalse(timingSafeEqual("known-state", "short"))
    }

    func test_access_token_claim_parser_preserves_durable_identity() throws {
        let userId = "56d9f140-60a6-4e9a-8cef-6a6b03967d3a"
        let sessionId = "08ac99da-8dad-4e29-8f2a-07757a2be79c"
        let payload: [String: Any] = [
            "iss": "https://project.supabase.co/auth/v1",
            "sub": userId.uppercased(),
            "session_id": sessionId.uppercased(),
            "aud": "authenticated",
            "aal": "aal2",
            "exp": 4_102_444_800
        ]
        let payloadData = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        let token = [Data("{}".utf8).base64URLEncodedString(), payloadData.base64URLEncodedString(), "synthetic-signature"].joined(separator: ".")
        let claims = try XCTUnwrap(parseAccessTokenClaims(token))
        XCTAssertEqual(claims.subject, userId)
        XCTAssertEqual(claims.sessionId, sessionId)
        XCTAssertEqual(claims.assuranceLevel, "aal2")
        XCTAssertTrue(claims.hasAuthenticatedAudience)
    }
}
