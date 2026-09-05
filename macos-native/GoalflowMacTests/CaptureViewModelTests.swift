import XCTest
@testable import GoalflowMac

@MainActor
final class CaptureViewModelTests: XCTestCase {
    private func makeVM(file: URL? = nil, suite: String? = nil, clock: any Clock = SystemClock()) -> (CaptureViewModel, LocalTaskStore, URL, UserDefaults) {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try! FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        let f = file ?? tmp.appendingPathComponent("tasks.json")
        let defaults = UserDefaults(suiteName: suite ?? UUID().uuidString)!
        let store = LocalTaskStore(fileURL: f, defaults: defaults)
        let svc = LocalCaptureService(taskStore: store, clock: clock)
        let vm = CaptureViewModel(taskStore: store, captureService: svc, clock: clock, privacy: NoopPrivacyGateway())
        return (vm, store, tmp, defaults)
    }

    func test_needsDate_factory_default() {
        let (vm, _, tmp, _) = makeVM(clock: ManualClock(now: ISO8601DateFormatter().date(from: "2026-09-01T00:00:00Z")!))
        defer { try? FileManager.default.removeItem(at: tmp) }
        vm.rawText = "Write proposal @25m"
        XCTAssertNil(vm.parsed.scheduledFor)
        XCTAssertTrue(vm.needsDate)
        XCTAssertFalse(vm.canSubmit)
        // Enter should show picker, not create
        let didCreate = vm.handleEnter(intent: .add)
        XCTAssertFalse(didCreate)
        XCTAssertTrue(vm.showDatePicker)
    }

    func test_with_parsed_date_canSubmit() {
        let (vm, _, tmp, _) = makeVM(clock: ManualClock(now: ISO8601DateFormatter().date(from: "2026-09-01T00:00:00Z")!))
        defer { try? FileManager.default.removeItem(at: tmp) }
        vm.rawText = "Write proposal @25m 2026-09-01"
        XCTAssertEqual(vm.parsed.scheduledFor, "2026-09-01")
        XCTAssertFalse(vm.needsDate)
        XCTAssertTrue(vm.canSubmit)
        XCTAssertFalse(vm.showDatePicker)
    }

    func test_create_add_via_picker() throws {
        let clock = ManualClock(now: ISO8601DateFormatter().date(from: "2026-09-01T00:00:00Z")!)
        let (vm, store, tmp, _) = makeVM(clock: clock)
        defer { try? FileManager.default.removeItem(at: tmp) }
        vm.rawText = "New task @15m"
        // first enter shows picker
        XCTAssertFalse(vm.handleEnter(intent: .add))
        XCTAssertTrue(vm.showDatePicker)
        // simulate user picked today
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = .current; f.locale = Locale(identifier: "en_US_POSIX")
        // selectedDate default is now, so second enter should create
        XCTAssertTrue(vm.handleEnter(intent: .add))
        let all = try store.loadAll()
        XCTAssertEqual(all.count, 1)
        XCTAssertEqual(all.first?.title, "New task")
        XCTAssertEqual(all.first?.scheduledFor, f.string(from: vm.selectedDate))
    }

    func test_month_future_via_picker() throws {
        let clock = ManualClock(now: ISO8601DateFormatter().date(from: "2026-09-01T00:00:00Z")!)
        let (vm, store, tmp, _) = makeVM(clock: clock)
        defer { try? FileManager.default.removeItem(at: tmp) }
        vm.rawText = "Future idea"
        _ = vm.handleEnter(intent: .add) // show picker
        vm.isMonthMode = true
        vm.selectedMonth = "2026-11"
        XCTAssertTrue(vm.handleEnter(intent: .add))
        XCTAssertEqual(try store.loadAll().first?.schedulePrecision, .month)
        XCTAssertEqual(try store.loadAll().first?.scheduledFor, "2026-11")
    }

    func test_notes_toggle_and_url() throws {
        let clock = ManualClock(now: ISO8601DateFormatter().date(from: "2026-09-01T00:00:00Z")!)
        let (vm, store, tmp, _) = makeVM(clock: clock)
        defer { try? FileManager.default.removeItem(at: tmp) }
        vm.rawText = "Check https://example.com 2026-09-01"
        vm.showNotes = true
        vm.notes = "my note"
        XCTAssertTrue(vm.handleEnter(intent: .add))
        let task = try XCTUnwrap(store.loadAll().first)
        XCTAssertTrue(task.notes.contains("my note"))
        XCTAssertTrue(task.notes.contains("https://example.com"))
    }

    func test_privacy_blank() {
        struct MockPrivacy: PrivacyGateway { var isScreenSharing: Bool { true } }
        let (vm, _, tmp, _) = {
            let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try! FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
            let f = tmp.appendingPathComponent("tasks.json")
            let defaults = UserDefaults(suiteName: UUID().uuidString)!
            let store = LocalTaskStore(fileURL: f, defaults: defaults)
            let svc = LocalCaptureService(taskStore: store, clock: SystemClock())
            let vm = CaptureViewModel(taskStore: store, captureService: svc, clock: SystemClock(), privacy: MockPrivacy())
            return (vm, store, tmp, defaults)
        }()
        defer { try? FileManager.default.removeItem(at: tmp) }
        vm.rawText = "Secret task 2026-09-01"
        XCTAssertEqual(vm.titlePreview, "••••••••")
    }

    func test_empty_title_fails() {
        let (vm, _, tmp, _) = makeVM(clock: ManualClock(now: ISO8601DateFormatter().date(from: "2026-09-01T00:00:00Z")!))
        defer { try? FileManager.default.removeItem(at: tmp) }
        vm.rawText = "@25m 2026-09-01"
        XCTAssertFalse(vm.canSubmit)
        vm.showDatePicker = false
        // force effective date
        vm.rawText = "@25m 2026-09-01" // still empty title
        XCTAssertFalse(vm.handleEnter(intent: .add))
        XCTAssertNotNil(vm.errorMessage)
    }
}
