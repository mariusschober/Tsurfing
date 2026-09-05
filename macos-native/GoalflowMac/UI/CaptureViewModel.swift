import Foundation
import Combine

@MainActor
final class CaptureViewModel: ObservableObject {
    @Published var rawText: String = "" { didSet { parse() } }
    @Published var parsed: ParsedCapture = ParsedCapture(cleanTitle: "", durationMinutes: nil, tags: [], urls: [], scheduledFor: nil, schedulePrecision: nil, scheduledTime: nil, isFrog: false, isQuickie: false, notes: nil)
    @Published var notes: String = ""
    @Published var showNotes: Bool = false
    @Published var showDatePicker: Bool = false
    @Published var selectedDate: Date = Date()
    @Published var selectedMonth: String = "" // YYYY-MM
    @Published var isMonthMode: Bool = false
    @Published var isScreenSharing: Bool = false
    @Published var errorMessage: String?

    private let taskStore: any TaskStore
    private let captureService: any CaptureService
    private let clock: any Clock
    private let privacy: any PrivacyGateway

    var onCreated: ((GoalflowTask, CaptureIntent) -> Void)?

    init(taskStore: any TaskStore = LocalTaskStore(), captureService: (any CaptureService)? = nil, clock: any Clock = SystemClock(), privacy: any PrivacyGateway = NoopPrivacyGateway()) {
        self.taskStore = taskStore
        self.clock = clock
        self.privacy = privacy
        if let svc = captureService { self.captureService = svc }
        else { self.captureService = LocalCaptureService(taskStore: taskStore, clock: clock) }
        parse()
        // privacy check on init
        checkPrivacy()
    }

    private func parse() {
        let today = makeTodayString(from: clock.now())
        parsed = CaptureParser.parse(raw: rawText, today: today)
        errorMessage = nil
        // if parsed has no scheduledFor but user has selected date, keep selected
        // screen sharing check
        checkPrivacy()
    }

    func checkPrivacy() {
        if privacy.isScreenSharing { isScreenSharing = true } else { isScreenSharing = false }
    }

    var titlePreview: String {
        if isScreenSharing { return "••••••••" }
        return parsed.cleanTitle.isEmpty ? "Untitled" : parsed.cleanTitle
    }

    var durationPreview: String {
        if let d = parsed.durationMinutes { return "\(d)m" } else { return "25m" }
    }

    var needsDate: Bool {
        // if parsed has scheduledFor, no need
        if parsed.scheduledFor != nil { return false }
        // if user picked date/month and picker is committed, then no need
        if !showDatePicker { return true }
        // picker shown but not yet confirmed? still needs until confirmed
        // For simplicity, if showDatePicker is true we are in picker mode, not needsDate for Enter handling
        return false
    }

    var effectiveScheduledFor: String? {
        if let sf = parsed.scheduledFor { return sf }
        if showDatePicker {
            if isMonthMode {
                if !selectedMonth.isEmpty { return selectedMonth }
                return nil
            } else {
                let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = .current; f.locale = Locale(identifier: "en_US_POSIX")
                return f.string(from: selectedDate)
            }
        }
        return nil
    }

    var effectivePrecision: SchedulePrecision? {
        if let p = parsed.schedulePrecision { return p }
        if showDatePicker {
            return isMonthMode ? .month : .day
        }
        return nil
    }

    var effectiveTime: String? { parsed.scheduledTime }

    var canSubmit: Bool {
        !parsed.cleanTitle.trimmingCharacters(in: .whitespaces).isEmpty && effectiveScheduledFor != nil
    }

    var displayError: String? { errorMessage }

    func toggleNotes() { showNotes.toggle() }

    // Called on Enter. Returns true if creation succeeded and should dismiss.
    func handleEnter(intent: CaptureIntent = .add) -> Bool {
        // If needs date and picker not shown, show picker
        if parsed.scheduledFor == nil && !showDatePicker {
            showDatePicker = true
            // default selectedDate to today, selectedMonth to next month
            selectedDate = Date()
            if let d = Calendar.current.date(byAdding: .month, value: 1, to: Date()) {
                let f = DateFormatter(); f.dateFormat = "yyyy-MM"; f.timeZone = .current; f.locale = Locale(identifier: "en_US_POSIX")
                selectedMonth = f.string(from: d)
            }
            isMonthMode = false
            return false
        }
        guard let sf = effectiveScheduledFor, let prec = effectivePrecision else {
            errorMessage = "Select a date."
            return false
        }
        // title validation
        if parsed.cleanTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            errorMessage = "Title is required."
            return false
        }
        // try create
        do {
            let task = try captureService.createTask(from: parsed, notes: showNotes ? notes : nil, scheduledFor: sf, precision: prec, scheduledTime: effectiveTime, intent: intent)
            onCreated?(task, intent)
            // reset
            rawText = ""
            notes = ""
            showNotes = false
            showDatePicker = false
            errorMessage = nil
            return true
        } catch let e as SchedulingError {
            errorMessage = e.message
            return false
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func submitAdd() -> Bool { handleEnter(intent: .add) }
    func submitAction() -> Bool { handleEnter(intent: .action) }

    func cancel() {
        rawText = ""
        notes = ""
        showNotes = false
        showDatePicker = false
        errorMessage = nil
    }
}
