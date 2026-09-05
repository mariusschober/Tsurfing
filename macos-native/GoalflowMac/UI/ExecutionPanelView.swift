import AppKit
import SwiftUI
import Combine

enum MacCloudState: Equatable {
    case authenticating
    case signedOut
    case mfaRequired
    case workspaceLinkRequired(String)
    case connected(String)
    case disconnected(String)
    case failed(String)
}

@MainActor
final class ExecutionViewModel: ObservableObject {
    @Published var task: GoalflowTask?
    @Published var execution: ExecutionState?
    @Published var remainingSeconds: Int = 0
    @Published var overtimeSeconds: Int = 0
    @Published var isPaused: Bool = false
    @Published var holdProgress: Double = 0
    @Published var holding: Bool = false
    @Published var flowPickerVisible: Bool = false
    @Published var showReward: Bool = false
    @Published var completedTodayCount: Int = 0
    @Published var queueCount: Int = 0
    @Published var breakState: BreakState?
    @Published var breakRemaining: Int? = nil
    @Published var breakElapsed: Int = 0
    @Published var isOnBreak: Bool = false
    @Published var breakPickerVisible: Bool = false
    @Published var gate: PlanningGate = .empty
    @Published var goals: [Goal] = []
    @Published var amalgam: String?
    @Published var trueNorth: [TrueNorthGoal] = []
    @Published var calendarCollision: CalendarCollision?
    @Published var showBreakdown: Bool = false
    @Published var breakdownSuggestions: [BreakdownSuggestion] = []
    @Published var breakdownChildren: [BreakdownChildInput] = []
    @Published var breakdownLoading: Bool = false
    @Published var breakdownError: String?
    @Published var showSignIn: Bool = false
    @Published var showAccount: Bool = false
    @Published var cloudState: MacCloudState = .authenticating
    @Published var cloudError: String?
    @Published var localError: String?
    @Published var conflicts: [LocalConflict] = []
    @Published var showConflicts: Bool = false
    private let provider: DemoCurrentTaskProvider
    private let store: any FocusSessionStore
    private let clock: any Clock
    private let timer = ExecutionTimer()
    private let breakTimer = BreakTimer()
    private let breakStore: BreakSessionStore
    private let sound: any SoundGateway
    private let dailyPlanStore: DailyPlanStore
    private let goalStore: GoalStore
    private let trueNorthStore: TrueNorthStore
    private let amalgamStore: AmalgamStore
    private let calendarService: any CalendarCollisionService
    private let breakdownGateway: any BreakdownGateway
    private let localBreakdown: LocalBreakdownService
    private let gateEnabled: Bool
    private let appOrigin: String
    private let syncMetaStore: SyncMetaStore
    private let syncEngine: SyncEngine
    private let authService: SupabaseAuthService
    private lazy var foregroundSyncCoordinator = MacForegroundSyncCoordinator(
        canSynchronize: { [weak self] in self?.isAuthenticated == true },
        synchronize: { [weak self] in await self?.performForegroundSync() }
    )
    private var verifiedProfile: GoalflowSessionProfile?
    private var cancellables: Set<AnyCancellable> = []
    private var lastTickOvertime: Int = 0
    private var holdController: CompletionHoldController?
    private var holdTimer: AnyCancellable?
    private var pendingCompletedId: String?
    init(provider: DemoCurrentTaskProvider, store: any FocusSessionStore, clock: any Clock = SystemClock(), sound: any SoundGateway = NoopSoundGateway(), breakStore: BreakSessionStore = BreakSessionStore(), dailyPlanStore: DailyPlanStore = DailyPlanStore(), goalStore: GoalStore = GoalStore(), trueNorthStore: TrueNorthStore = TrueNorthStore(), amalgamStore: AmalgamStore = AmalgamStore(), calendarService: any CalendarCollisionService = NoopCalendarService(), breakdownGateway: any BreakdownGateway = StubBreakdownGateway(), gateEnabled: Bool = false, appOrigin: String = "https://app.tsurfing.com", syncMetaStore: SyncMetaStore? = nil, syncEngine: SyncEngine? = nil, authService: SupabaseAuthService = .shared) {
        self.provider = provider; self.store = store; self.clock = clock; self.sound = sound; self.breakStore = breakStore
        self.dailyPlanStore = dailyPlanStore; self.goalStore = goalStore; self.trueNorthStore = trueNorthStore; self.amalgamStore = amalgamStore
        self.calendarService = calendarService; self.breakdownGateway = breakdownGateway
        self.localBreakdown = LocalBreakdownService(taskStore: provider.taskStore, clock: clock, dailyPlanStore: dailyPlanStore)
        self.gateEnabled = gateEnabled; self.appOrigin = appOrigin
        self.authService = authService
        let syncFile = (provider.taskStore as? LocalTaskStore)?.fileURL.deletingLastPathComponent().appendingPathComponent("sync.json")
        self.syncMetaStore = syncMetaStore ?? SyncMetaStore(fileURL: syncFile)
        self.syncEngine = syncEngine ?? SyncEngine(metaStore: self.syncMetaStore)
        setupTimerBindings(); restore(); restoreBreak()
        NotificationCenter.default.publisher(for: .authDidChange).receive(on: DispatchQueue.main).sink { [weak self] notification in
            if let message = notification.object as? String { self?.cloudError = message }
            Task { @MainActor in await self?.refreshCloudState() }
        }.store(in: &cancellables)
        NotificationCenter.default.publisher(for: .syncMutationCommitted).receive(on: DispatchQueue.main).sink { [weak self] _ in
            self?.triggerSyncIfNeeded()
        }.store(in: &cancellables)
        foregroundSyncCoordinator.start()
        Task { await refreshCloudState() }
    }
    private func setupTimerBindings() {
        timer.$remainingSeconds.receive(on: DispatchQueue.main).sink { [weak self] v in self?.remainingSeconds = v }.store(in: &cancellables)
        timer.$overtimeSeconds.receive(on: DispatchQueue.main).sink { [weak self] v in
            guard let self else { return }; self.overtimeSeconds = v
            if self.execution?.isActive == true && v != self.lastTickOvertime { self.sound.tick(volume: 0.6) }
            self.lastTickOvertime = v
        }.store(in: &cancellables)
        timer.$isPaused.receive(on: DispatchQueue.main).sink { [weak self] v in self?.isPaused = v }.store(in: &cancellables)
        timer.$isActive.receive(on: DispatchQueue.main).sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &cancellables)
        breakTimer.$remainingSeconds.receive(on: DispatchQueue.main).sink { [weak self] v in self?.breakRemaining = v }.store(in: &cancellables)
        breakTimer.$elapsedSeconds.receive(on: DispatchQueue.main).sink { [weak self] v in self?.breakElapsed = v }.store(in: &cancellables)
        breakTimer.$isActive.receive(on: DispatchQueue.main).sink { [weak self] v in self?.isOnBreak = v; if !v { self?.handleBreakExpiredIfNeeded() } }.store(in: &cancellables)
        breakTimer.$isExpired.receive(on: DispatchQueue.main).sink { [weak self] expired in
            if expired { self?.sound.alarm(loop: true) }
        }.store(in: &cancellables)
    }
    func restore() {
        do {
            let today = todayString()
            let loadedGoals = try goalStore.loadAll()
            let loadedAmalgam = try amalgamStore.load()
            let loadedTrueNorth = try trueNorthStore.loadAll()
            let loadedMeta = try syncMetaStore.load()
            let loadedCompletedCount = try provider.completedCount(today: today)
            let loadedQueueCount = try provider.queueCount(today: today)
            let loadedGate: PlanningGate
            let loadedTask: GoalflowTask?
            if gateEnabled {
                let tasks = try provider.taskStore.loadAll()
                let plan = try dailyPlanStore.load(for: today)
                loadedGate = getPlanningGate(tasks: tasks, today: today, dailyPlan: plan)
                if case .ready(let queue) = loadedGate { loadedTask = queue.first }
                else { loadedTask = nil }
            } else {
                loadedTask = try provider.fetchCurrent()
                loadedGate = loadedTask.map { .ready(queue: [$0]) } ?? .empty
            }
            var loadedExecution = try store.load()
            if let session = loadedExecution,
               loadedTask?.id != session.taskId || loadedTask?.isOpen != true {
                try store.clear()
                loadedExecution = nil
            }

            goals = loadedGoals
            amalgam = loadedAmalgam
            trueNorth = loadedTrueNorth
            conflicts = loadedMeta.conflicts
            completedTodayCount = loadedCompletedCount
            queueCount = loadedQueueCount
            gate = loadedGate
            task = loadedTask
            execution = loadedExecution
            localError = nil
            configureTimer()
            checkCalendarCollision()
        } catch {
            localError = "Local data needs attention: \(error.localizedDescription)"
        }
    }

    private func checkCalendarCollision() {
        guard let t = task, t.scheduledTime != nil else { calendarCollision = nil; return }
        Task { @MainActor in
            let c = await calendarService.collision(for: t, today: todayString())
            self.calendarCollision = c
        }
    }

    private func reportLocalFailure(_ error: Error) {
        localError = "Local change was not confirmed: \(error.localizedDescription)"
    }

    private func clearLocalFailure() {
        localError = nil
    }

    func reportCaptureStartFailure(_ error: Error) {
        localError = "Task captured, but focus did not start: \(error.localizedDescription)"
    }

    func requestCalendarAccess() {
        Task { @MainActor in
            _ = await calendarService.requestAccessIfNeeded()
            checkCalendarCollision()
        }
    }

    func openWebPlan() {
        let urlStr = "\(appOrigin)?view=planning"
        if let url = URL(string: urlStr) { NSWorkspace.shared.open(url) }
    }

    func goal(for task: GoalflowTask) -> Goal? {
        guard let gid = task.goalId else { return nil }
        return goals.first { $0.id == gid }
    }

    // MARK: - Sync

    var isAuthenticated: Bool {
        if case .connected = cloudState { return true }
        return false
    }

    var canSignOut: Bool {
        switch cloudState {
        case .connected, .mfaRequired, .workspaceLinkRequired: return true
        default: return false
        }
    }

    func refreshCloudState() async {
        guard authService.isConfigured else {
            cloudState = .disconnected(authService.configurationProblem ?? "Cloud sync is not configured.")
            return
        }
        defer { foregroundSyncCoordinator.sessionChanged() }
        cloudState = .authenticating
        do {
            let profile = try await authService.validateCurrentSession()
            verifiedProfile = profile
            if profile.requiresMFA {
                cloudState = .mfaRequired
            } else {
                switch try syncEngine.bindingState(for: profile.userId) {
                case .unbound: cloudState = .workspaceLinkRequired(profile.email)
                case .bound: cloudState = .connected(profile.email)
                case .differentAccount: throw SyncError.accountMismatch
                }
            }
            cloudError = nil
            if case .connected = cloudState { triggerSyncIfNeeded() }
        } catch KeychainError.noSession {
            verifiedProfile = nil
            cloudState = .signedOut
        } catch KeychainError.revoked {
            verifiedProfile = nil
            cloudState = .signedOut
        } catch AuthError.revoked {
            verifiedProfile = nil
            cloudState = .signedOut
        } catch {
            cloudState = .failed(error.localizedDescription)
            cloudError = error.localizedDescription
        }
    }

    func linkLocalWorkspace() {
        Task { @MainActor in
            cloudState = .authenticating
            do {
                let profile = try await authService.validateCurrentSession()
                guard !profile.requiresMFA else {
                    verifiedProfile = profile
                    cloudState = .mfaRequired
                    return
                }
                if let expected = verifiedProfile?.userId, expected != profile.userId {
                    throw AuthError.sessionChanged
                }
                try await syncEngine.bindLocalWorkspace(to: profile.userId)
                verifiedProfile = profile
                cloudState = .connected(profile.email)
                cloudError = nil
                triggerSyncIfNeeded()
            } catch {
                cloudState = .failed(error.localizedDescription)
                cloudError = error.localizedDescription
            }
        }
    }

    func triggerSyncIfNeeded() {
        foregroundSyncCoordinator.requestSync()
    }

    private func performForegroundSync() async {
        guard isAuthenticated else { return }
        do {
            try await syncEngine.synchronize()
            cloudError = nil
            restore()
        } catch {
            cloudError = error.localizedDescription
        }
    }

    func applicationDidBecomeActive() {
        foregroundSyncCoordinator.applicationDidBecomeActive()
    }

    func applicationWillTerminate() {
        foregroundSyncCoordinator.shutdown()
    }

    func signOut() {
        Task { @MainActor in
            do {
                try await authService.signOut()
                verifiedProfile = nil
                cloudState = .signedOut
                cloudError = nil
                foregroundSyncCoordinator.sessionChanged()
            } catch {
                verifiedProfile = nil
                cloudState = .signedOut
                cloudError = error.localizedDescription
                foregroundSyncCoordinator.sessionChanged()
            }
        }
    }

    func resolveConflict(id: String, useLocal: Bool) {
        Task { @MainActor in
            do {
                try await syncEngine.resolveConflict(id: id, useLocal: useLocal)
                cloudError = nil
                restore()
            } catch {
                cloudError = error.localizedDescription
            }
        }
    }

    // MARK: - Breakdown

    func openBreakdown() {
        guard let t = task else { return }
        showBreakdown = true
        breakdownSuggestions = []
        breakdownChildren = []
        breakdownError = nil
        breakdownLoading = true
        Task { @MainActor in
            do {
                let sug = try await breakdownGateway.suggest(for: t)
                self.breakdownSuggestions = sug
            } catch let e as BreakdownError {
                self.breakdownError = e.localizedDescription
            } catch {
                self.breakdownError = nil // silent, manual still allowed
            }
            self.breakdownLoading = false
        }
    }

    func stageSuggestion(_ s: BreakdownSuggestion) {
        breakdownChildren.append(BreakdownChildInput(title: s.title, durationMinutes: s.estimatedDuration))
    }

    func stageManual(title: String, duration: Int) {
        breakdownChildren.append(BreakdownChildInput(title: title, durationMinutes: max(1, min(1440, duration))))
    }

    func removeStaged(at idx: Int) {
        guard breakdownChildren.indices.contains(idx) else { return }
        breakdownChildren.remove(at: idx)
    }

    func confirmBreakdown() {
        guard let t = task else { return }
        guard !breakdownChildren.isEmpty else { return }
        do {
            _ = try localBreakdown.breakdown(taskId: t.id, children: breakdownChildren)
            // Clear focus if breaking current active task
            if execution?.taskId == t.id {
                try store.clear()
                execution = nil
                timer.stop()
            }
            clearLocalFailure()
            restore()
        } catch {
            breakdownError = error.localizedDescription
        }
    }

    private func configureTimer() {
        timer.configure(state: execution, clock: clock)
        if let e = execution { remainingSeconds = e.remainingSeconds(now: clock.now()); overtimeSeconds = e.overtimeSeconds(now: clock.now()); isPaused = e.isPaused }
        else if let t = task { remainingSeconds = t.plannedDurationSeconds; overtimeSeconds = 0; isPaused = false }
        else { remainingSeconds = 0; overtimeSeconds = 0; isPaused = false }
    }

    func restoreBreak() {
        do {
            if let bs = try breakStore.load() {
                breakState = bs
                breakTimer.configure(state: bs, clock: clock)
                isOnBreak = true
                breakRemaining = bs.remainingSeconds(now: clock.now())
                breakElapsed = bs.elapsedSeconds(now: clock.now())
                if bs.isExpired(now: clock.now()) {
                    sound.alarm(loop: true)
                }
            } else {
                breakState = nil
                breakRemaining = nil
                breakElapsed = 0
                isOnBreak = false
            }
        } catch {
            reportLocalFailure(error)
        }
    }

    func startBreak(durationMinutes: Int?) {
        if let e = execution, e.isActive {
            if let paused = e.paused(at: clock.now()) {
                do {
                    try store.save(paused)
                    execution = paused
                    timer.reflectPause(paused)
                    isPaused = true
                    remainingSeconds = paused.remainingSeconds(now: clock.now())
                    overtimeSeconds = paused.overtimeSeconds(now: clock.now())
                } catch {
                    reportLocalFailure(error)
                    return
                }
            }
        }
        let durationSeconds: Int? = durationMinutes.map { $0 * 60 }
        let bs = BreakState(durationSeconds: durationSeconds, startedAt: clock.now(), startedAtMonotonic: (clock as? any MonotonicClock)?.monotonicNow, sourcePhase: execution?.phase ?? .idle, taskId: task?.id)
        do {
            try breakStore.save(bs)
            breakState = bs
            breakTimer.start(state: bs)
            isOnBreak = true
            breakRemaining = bs.remainingSeconds(now: clock.now())
            breakElapsed = bs.elapsedSeconds(now: clock.now())
            breakPickerVisible = false
            clearLocalFailure()
        } catch {
            reportLocalFailure(error)
        }
    }

    func endBreakEarly() {
        guard isOnBreak else { return }
        do { try breakStore.clear() }
        catch {
            reportLocalFailure(error)
            return
        }
        breakTimer.stop()
        isOnBreak = false
        breakState = nil
        breakRemaining = nil
        breakElapsed = 0
        sound.stopAlarm()
        if let e = execution {
            remainingSeconds = e.remainingSeconds(now: clock.now())
            overtimeSeconds = e.overtimeSeconds(now: clock.now())
        }
        breakPickerVisible = false
        clearLocalFailure()
    }

    private func handleBreakExpiredIfNeeded() {
        if let bs = breakState, bs.isExpired(now: clock.now()) {
            sound.alarm(loop: true)
        }
    }

    var isActive: Bool { execution?.isActive == true }
    var isOvertime: Bool { overtimeSeconds > 0 }
    var progress: Double {
        guard let t = task else { return 0 }
        let total = Double(t.plannedDurationSeconds); guard total > 0 else { return 0 }
        if isOvertime { return 1.0 }
        return max(0, min(1, Double(remainingSeconds) / total))
    }
    var displayTime: String {
        if isOvertime { let m = overtimeSeconds / 60; let s = overtimeSeconds % 60; return String(format: "+%02d:%02d", m, s) }
        if let e = execution, e.isActive || e.isPaused {
            let rem = e.isPaused ? e.remainingSeconds(now: clock.now()) : remainingSeconds
            return String(format: "%02d:%02d", rem / 60, rem % 60)
        } else if let t = task { return String(format: "%02d:00", t.durationMinutes) }
        return "--:--"
    }
    func action() {
        guard let t = task else { return }
        if execution?.isActive == true || execution?.isPaused == true { return }
        let monotonic: UInt64? = (clock as? any MonotonicClock)?.monotonicNow
        let state = ExecutionState(taskId: t.id, phase: .active, startedAt: clock.now(), startedAtMonotonic: monotonic, plannedDurationSeconds: t.plannedDurationSeconds)
        do { try store.save(state); execution = state; timer.start(state: state); clearLocalFailure() }
        catch { reportLocalFailure(error) }
    }
    func pause() {
        guard let e = execution, e.isActive else { return }
        guard let next = e.paused(at: clock.now()) else { return }
        do { try store.save(next); execution = next; timer.reflectPause(next); clearLocalFailure() }
        catch { reportLocalFailure(error) }
    }
    func resume() {
        guard let e = execution, e.isPaused else { return }
        guard let next = e.resumed(at: clock.now()) else { return }
        do { try store.save(next); execution = next; timer.reflectResume(next); clearLocalFailure() }
        catch { reportLocalFailure(error) }
    }
    func extend(by seconds: Int) {
        guard let e = execution, let next = e.extended(by: seconds) else { return }
        do { try store.save(next); execution = next; timer.reflectExtend(next); clearLocalFailure() }
        catch { reportLocalFailure(error) }
    }
    func add5() { extend(by: 5*60) }; func add15() { extend(by: 15*60) }; func add30() { extend(by: 30*60) }

    // MARK: - Break

    var holdDuration: TimeInterval { (task?.isFrog == true) ? 5.0 : 3.0 }
    func beginHold() {
        guard let t = task, execution != nil, !holding else { return }
        holdController = CompletionHoldController(isFrog: t.isFrog, clock: clock)
        holdController?.start(at: clock.now())
        holding = true; holdProgress = 0
        holdTimer?.cancel()
        holdTimer = Timer.publish(every: 0.02, on: .main, in: .common).autoconnect().sink { [weak self] _ in
            guard let self, let hc = self.holdController else { return }
            let p = hc.progress(at: self.clock.now())
            self.holdProgress = p
            if p >= 0.33 && p < 0.35 { self.haptic(1) }
            if p >= 0.66 && p < 0.68 { self.haptic(1) }
            if hc.isCompleted(at: self.clock.now()) {
                self.holdTimer?.cancel(); self.holding = false; self.holdProgress = 1; self.confirmCompletion()
            }
        }
        haptic(0)
    }
    func endHold(cancelled: Bool) {
        guard holding else { return }
        holdTimer?.cancel(); holdTimer = nil
        if cancelled || !(holdController?.isCompleted(at: clock.now()) ?? false) {
            withAnimation(.easeOut(duration: 0.2)) { holdProgress = 0 }
            holding = false; holdController?.cancel()
        }
    }
    private func haptic(_ type: Int) {
        if #available(macOS 11.0, *) {
            if type == 0 { NSHapticFeedbackManager.defaultPerformer.perform(.generic, performanceTime: .default) }
            else if type == 1 { NSHapticFeedbackManager.defaultPerformer.perform(.levelChange, performanceTime: .default) }
            else { NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .default) }
        }
    }
    private func confirmCompletion() {
        guard let t = task, let exec = execution else { return }
        let elapsed = exec.elapsedSeconds(now: clock.now())
        let actual = max(1, Int(ceil(Double(elapsed) / 60.0)))
        do {
            let completed: GoalflowTask
            completed = try provider.completeTask(id: t.id, actualDurationMinutes: actual, flowState: nil)
            pendingCompletedId = completed.id
            try store.clear(); timer.stop(); execution = nil
            sound.complete(frog: t.isFrog)
            withAnimation(.easeOut(duration: 0.3)) { showReward = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in self?.showReward = false; self?.flowPickerVisible = true }
            haptic(2)
            task = try provider.fetchCurrent()
            completedTodayCount = try provider.completedCount(today: todayString())
            queueCount = try provider.queueCount(today: todayString())
            clearLocalFailure()
        } catch {
            let message = "Local change was not confirmed: \(error.localizedDescription)"
            holdProgress = 0; holding = false; holdController?.cancel()
            restore()
            localError = message
        }
    }
    func selectFlow(_ flow: FlowState) {
        guard let id = pendingCompletedId else { flowPickerVisible = false; return }
        do {
            try provider.updateFlowState(taskId: id, flow: flow)
            flowPickerVisible = false
            pendingCompletedId = nil
            clearLocalFailure()
            restore()
        } catch {
            reportLocalFailure(error)
        }
    }
    func skipFlow() {
        flowPickerVisible = false
        pendingCompletedId = nil
        restore()
    }
    func toggleFrog() {
        guard let t = task else { return }
        do {
            try provider.setFrogDemo(isFrog: !t.isFrog)
            clearLocalFailure()
            restore()
        } catch {
            reportLocalFailure(error)
        }
    }
    func resetDemo() {
        do {
            try store.clear()
            try provider.resetDemo()
            execution = nil
            flowPickerVisible = false
            pendingCompletedId = nil
            holdProgress = 0
            holding = false
            showReward = false
            clearLocalFailure()
            restore()
        } catch {
            reportLocalFailure(error)
        }
    }
    private func todayString() -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = .current; f.locale = Locale(identifier: "en_US_POSIX")
        return f.string(from: Date())
    }
}
struct ExecutionPanelView: View {
    @ObservedObject var vm: ExecutionViewModel
    @Environment(\.colorScheme) var colorScheme
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let am = vm.amalgam, !am.isEmpty { amalgamBanner(text: am) }
            header
            if let notice = cloudNotice { cloudNoticeBanner(notice) }
            Divider().opacity(0.08)
            if vm.isOnBreak {
                breakActiveView
            } else if vm.flowPickerVisible { flowPicker } else if vm.breakPickerVisible { breakPicker } else if isGateWall { gateWall } else if let task = vm.task { content(task: task) } else { empty }
            footer
            if !vm.trueNorth.isEmpty { trueNorthFooter }
        }.sheet(isPresented: $vm.showBreakdown) { BreakdownSheet(vm: vm) }
         .sheet(isPresented: $vm.showSignIn) { SignInView(onClose: { vm.showSignIn = false }) }
         .sheet(isPresented: $vm.showAccount) { SignInView(accountMode: true, onClose: { vm.showAccount = false }) }
         .sheet(isPresented: $vm.showConflicts) { ConflictsSheet(vm: vm) }
        .frame(width: 380)
        .background(panelBackground)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.primary.opacity(0.06), lineWidth: 1))
        .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.5 : 0.18), radius: 18, x: 0, y: 10)
        .padding(10)
        .overlay(rewardOverlay)
    }
    private var panelBackground: some View {
        Group {
            if #available(macOS 13.0, *) {
                ZStack {
                    RoundedRectangle(cornerRadius: 18, style: .continuous).fill(.ultraThinMaterial)
                    if vm.isActive || vm.isPaused || vm.isOvertime || vm.showReward {
                        RoundedRectangle(cornerRadius: 18, style: .continuous).fill((vm.isOvertime ? Color.orange.opacity(0.08) : Color.blue.opacity(0.06)))
                    }
                }
            } else { Color(nsColor: .windowBackgroundColor) }
        }
    }

    private var cloudNotice: String? {
        if let localError = vm.localError, !localError.isEmpty { return localError }
        if let cloudError = vm.cloudError, !cloudError.isEmpty { return cloudError }
        switch vm.cloudState {
        case .workspaceLinkRequired(let email):
            return "Cloud identity \(email) is verified. Confirm the link before any local data is synchronized."
        case .disconnected(let message), .failed(let message): return message
        default: return nil
        }
    }

    private func cloudNoticeBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "icloud.slash.fill")
                .font(.system(size: 10))
                .foregroundStyle(Color.orange)
            Text(message)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(3)
            Spacer(minLength: 4)
            if vm.localError != nil {
                Button("Retry load") { vm.restore(); vm.restoreBreak() }
                    .buttonStyle(.link)
                    .font(.system(size: 10, weight: .semibold))
            } else if case .workspaceLinkRequired = vm.cloudState {
                Button("Link workspace") { vm.linkLocalWorkspace() }
                    .buttonStyle(.link)
                    .font(.system(size: 10, weight: .semibold))
            } else {
                Button("Sign in") { vm.showSignIn = true }
                    .buttonStyle(.link)
                    .font(.system(size: 10, weight: .semibold))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color.orange.opacity(0.08))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Tsurfing needs attention. \(message)")
    }
    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: vm.isOnBreak ? "cup.and.saucer.fill" : vm.isPaused ? "pause.circle.fill" : vm.isOvertime ? "exclamationmark.circle.fill" : "scope")
                .font(.system(size: 12, weight: .semibold)).foregroundStyle(vm.isOnBreak ? Color.teal : vm.isOvertime ? Color.orange : .secondary)
            Text(vm.isOnBreak ? "On Break" : vm.isPaused ? "Paused" : vm.isOvertime ? "Overtime" : "Current")
                .font(.system(size: 11, weight: .semibold, design: .rounded)).tracking(0.8).textCase(.uppercase)
                .foregroundStyle(vm.isOnBreak ? Color.teal : vm.isOvertime ? Color.orange : .secondary)
            Spacer()
            cloudControl
            if !vm.conflicts.isEmpty {
                Button(action: { vm.showConflicts = true }) {
                    HStack(spacing: 4) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).font(.system(size: 10))
                        Text("\(vm.conflicts.count)").font(.system(size: 10, weight: .bold, design: .rounded)).foregroundStyle(.orange)
                    }
                }.buttonStyle(.plain).help("\(vm.conflicts.count) sync conflict(s)")
            }
            if let task = vm.task, task.isFrog { FrogBadge(compact: true) }
            Menu {
                Button(vm.isPaused ? "Resume" : "Pause") { if vm.isPaused { vm.resume() } else { vm.pause() } }.disabled(!(vm.isActive || vm.isPaused))
                Divider()
                Button("+5 min") { vm.add5() }.disabled(vm.execution == nil)
                Button("+15 min") { vm.add15() }.disabled(vm.execution == nil)
                Button("+30 min") { vm.add30() }.disabled(vm.execution == nil)
                Divider()
                Button("Toggle Frog") { vm.toggleFrog() }
                #if DEBUG
                Button("Reset Demo (clear session)") { vm.resetDemo() }
                #endif
                Divider()
                Button("Check for Updates…") { UpdaterService.shared.checkForUpdates() }
                Divider()
                if vm.canSignOut {
                    Button("Account…") { vm.showAccount = true }
                    Button("Sign out") { vm.signOut() }
                } else {
                    Button("Sign in…") { vm.showSignIn = true }
                }
            } label: { Image(systemName: "ellipsis.circle").foregroundStyle(.secondary).font(.system(size: 12)) }
            .menuStyle(.borderlessButton).fixedSize()
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
    }

    @ViewBuilder
    private var cloudControl: some View {
        switch vm.cloudState {
        case .connected(let email):
            Image(systemName: "checkmark.shield.fill")
                .font(.system(size: 10)).foregroundStyle(.green)
                .help("Cloud session verified for \(email)")
        case .authenticating:
            ProgressView().controlSize(.mini).help("Verifying cloud session")
        case .mfaRequired:
            Button("Verify MFA") { vm.showSignIn = true }
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.orange)
                .help("Owner cloud synchronization requires AAL2")
        case .workspaceLinkRequired:
            Button("Link workspace") { vm.linkLocalWorkspace() }
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.orange)
                .help("No local data is uploaded until you confirm this account link")
        case .disconnected(let message), .failed(let message):
            Button(action: { vm.showSignIn = true }) {
                Image(systemName: "icloud.slash.fill").font(.system(size: 10)).foregroundStyle(.orange)
            }.buttonStyle(.plain).help(message)
        case .signedOut:
            Button("Sign in") { vm.showSignIn = true }
                .font(.system(size: 10, weight: .semibold, design: .rounded)).foregroundStyle(Color.blue)
        }
    }
    private var flowPicker: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("How was your focus?").font(.system(size: 14, weight: .semibold, design: .rounded))
            Text("Pick one — ~1 sec, no typing. Esc to skip.").font(.system(size: 11, weight: .regular)).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                ForEach(FlowState.allCases, id: \.rawValue) { flow in
                    Button(action: { vm.selectFlow(flow) }) {
                        VStack(spacing: 4) {
                            Text(flow.shortLabel).font(.system(size: 12, weight: .bold, design: .rounded))
                            Text(flow == .distracted ? "1" : flow == .good ? "2" : flow == .high ? "3" : "4").font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 10)
                        .background(Capsule().fill(colorForFlow(flow).opacity(0.14)))
                        .overlay(Capsule().stroke(colorForFlow(flow).opacity(0.22), lineWidth: 1))
                    }.buttonStyle(.plain).keyboardShortcut(flow == .distracted ? "1" : flow == .good ? "2" : flow == .high ? "3" : "4")
                }
            }
            Button("Skip (Esc)") { vm.skipFlow() }.font(.system(size: 11, weight: .regular)).foregroundStyle(.secondary).keyboardShortcut(.cancelAction)
        }.padding(.horizontal, 16).padding(.vertical, 18)
    }
    private func colorForFlow(_ flow: FlowState) -> Color {
        switch flow { case .distracted: return Color.gray; case .good: return Color.blue; case .high: return Color.indigo; case .flow: return Color.purple }
    }

    private var breakPicker: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Take a break — leave the Mac.").font(.system(size: 13, weight: .semibold, design: .rounded))
            Text("Choose duration. The screen will cover all displays.").font(.system(size: 11, weight: .regular)).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                ForEach([5,10,15,20], id: \.self) { mins in
                    Button(action: { vm.startBreak(durationMinutes: mins) }) {
                        Text("\(mins)m").font(.system(size: 12, weight: .bold, design: .rounded))
                            .frame(maxWidth: .infinity).padding(.vertical, 10)
                            .background(Capsule().fill(Color.teal.opacity(0.14)))
                            .overlay(Capsule().stroke(Color.teal.opacity(0.24), lineWidth: 1))
                    }.buttonStyle(.plain).keyboardShortcut(mins == 5 ? "1" : mins == 10 ? "2" : mins == 15 ? "3" : "4")
                }
                Button(action: { vm.startBreak(durationMinutes: nil) }) {
                    Text("Open").font(.system(size: 12, weight: .bold, design: .rounded))
                        .frame(maxWidth: .infinity).padding(.vertical, 10)
                        .background(Capsule().fill(Color.gray.opacity(0.12)))
                        .overlay(Capsule().stroke(Color.gray.opacity(0.22), lineWidth: 1))
                }.buttonStyle(.plain).keyboardShortcut("5")
            }
            Button("Cancel (Esc)") { vm.breakPickerVisible = false }.font(.system(size: 11, weight: .regular)).foregroundStyle(.secondary).keyboardShortcut(.cancelAction)
        }.padding(.horizontal, 16).padding(.vertical, 16)
    }

    private var breakActiveView: some View {
        VStack(spacing: 16) {
            Text("On Break").font(.system(size: 13, weight: .semibold, design: .rounded)).foregroundStyle(Color.teal)
            Text(vm.breakState?.isOpenEnded == true ? String(format: "%02d:%02d", vm.breakElapsed/60, vm.breakElapsed%60) : String(format: "%02d:%02d", (vm.breakRemaining ?? 0)/60, (vm.breakRemaining ?? 0)%60))
                .font(.system(size: 36, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(Color.teal)
            Text("Breathe. Relax. Reset.").font(.system(size: 11, weight: .regular)).foregroundStyle(.secondary)
            Text("Covering all displays • Esc to End Early").font(.system(size: 10, weight: .regular)).foregroundStyle(.secondary.opacity(0.7))
            Button("End Break Early (Esc)") { vm.endBreakEarly() }.buttonStyle(.bordered).keyboardShortcut(.cancelAction)
        }.padding(24).frame(maxWidth: .infinity)
    }
    private func content(task: GoalflowTask) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                Text(task.title).font(.system(size: 20, weight: .semibold, design: .rounded)).lineLimit(2).help(task.title)
                HStack(spacing: 8) {
                    Label("\(task.durationMinutes)m", systemImage: "timer").font(.system(size: 11, weight: .medium, design: .rounded)).foregroundStyle(.secondary)
                    if !task.tags.isEmpty { ForEach(task.tags, id: \.self) { tag in Text("#\(tag)").font(.system(size: 11, weight: .medium, design: .rounded)).foregroundStyle(Color.blue).padding(.horizontal, 6).padding(.vertical, 2).background(Color.blue.opacity(0.10)).clipShape(Capsule()) } }
                    Spacer()
                    if vm.isActive || vm.isPaused {
                        Text(vm.isPaused ? "Paused" : vm.isOvertime ? "Overtime \(vm.displayTime)" : "Focused")
                            .font(.system(size: 10, weight: .semibold, design: .rounded)).tracking(0.6).textCase(.uppercase)
                            .foregroundStyle(vm.isOvertime ? Color.orange : vm.isPaused ? Color.orange : Color.green)
                    }
                }
                if let goal = vm.goal(for: task) {
                    HStack(spacing: 6) {
                        Circle().fill(Color(hex: goal.color) ?? Color.blue).frame(width: 8, height: 8)
                        Text(goal.name).font(.system(size: 11, weight: .medium, design: .rounded)).foregroundStyle(.secondary)
                    }
                }
                if let coll = vm.calendarCollision {
                    HStack(spacing: 6) {
                        Image(systemName: "calendar.badge.exclamationmark").font(.system(size: 11, weight: .semibold))
                        Text("Overlaps calendar: “\(coll.eventTitle)” \(coll.start.formatted(date: .omitted, time: .shortened))–\(coll.end.formatted(date: .omitted, time: .shortened))")
                            .font(.system(size: 11, weight: .medium, design: .rounded)).lineLimit(1)
                    }.foregroundStyle(Color.orange).padding(.horizontal, 8).padding(.vertical, 4).background(Capsule().fill(Color.orange.opacity(0.12)))
                } else if task.scheduledTime != nil {
                    Button(action: { vm.requestCalendarAccess() }) {
                        Label("Check calendar for overlaps", systemImage: "calendar").font(.system(size: 10, weight: .medium, design: .rounded)).foregroundStyle(.secondary)
                    }.buttonStyle(.plain)
                }
            }
            HStack(spacing: 16) {
                ZStack {
                    CircularProgress(progress: vm.progress, lineWidth: 4, tint: vm.isOvertime ? Color.orange : task.isFrog ? Color.green : Color.blue, inactive: !(vm.isActive || vm.isPaused || vm.isOvertime))
                        .frame(width: 72, height: 72)
                    if vm.holding {
                        CircularProgress(progress: vm.holdProgress, lineWidth: 6, tint: task.isFrog ? Color.green : Color.blue, inactive: false)
                            .frame(width: 84, height: 84).opacity(0.9)
                    }
                    Text(vm.displayTime).font(.system(size: vm.isActive || vm.isPaused ? 18 : 16, weight: .semibold, design: .monospaced)).monospacedDigit().foregroundStyle((vm.isActive || vm.isPaused || vm.isOvertime) ? (vm.isOvertime ? Color.orange : .primary) : .secondary)
                }.id(vm.execution?.startedAt)
                Spacer(minLength: 8)
                if vm.isActive || vm.isPaused {
                    VStack(alignment: .trailing, spacing: 8) {
                        HStack(spacing: 8) {
                            if vm.isPaused {
                                Button(action: { vm.resume() }) {
                                    HStack(spacing: 6) { Image(systemName: "play.fill").font(.system(size: 11, weight: .bold)); Text("Resume").font(.system(size: 12, weight: .bold, design: .rounded)) }
                                    .foregroundStyle(.white).padding(.horizontal, 14).padding(.vertical, 10).background(Capsule().fill(Color.green)).shadow(color: Color.green.opacity(0.25), radius: 8, x: 0, y: 4)
                                }.buttonStyle(.plain).accessibilityLabel("Resume focus").accessibilityIdentifier("resume-button")
                            } else {
                                Button(action: { vm.pause() }) {
                                    HStack(spacing: 6) { Image(systemName: "pause.fill").font(.system(size: 11, weight: .bold)); Text("Pause").font(.system(size: 12, weight: .bold, design: .rounded)) }
                                    .foregroundStyle(.white).padding(.horizontal, 14).padding(.vertical, 10).background(Capsule().fill(Color.orange)).shadow(color: Color.orange.opacity(0.25), radius: 8, x: 0, y: 4)
                                }.buttonStyle(.plain).accessibilityLabel("Pause focus").accessibilityIdentifier("pause-button")
                            }
                        }
                        HStack(spacing: 6) {
                            ForEach([(5,"+5"),(15,"+15"),(30,"+30")], id: \.0) { sec, label in
                                Button(action: { if sec==5 { vm.add5() } else if sec==15 { vm.add15() } else { vm.add30() } }) {
                                    Text(label).font(.system(size: 11, weight: .semibold, design: .rounded)).foregroundStyle(.secondary).padding(.horizontal, 8).padding(.vertical, 6).background(Capsule().fill(Color.primary.opacity(0.08)))
                                }.buttonStyle(.plain)
                            }
                        }
                        holdButton(task: task)
                    }
                } else {
                    Button(action: { vm.action() }) {
                        HStack(spacing: 8) { Text("ACTION").font(.system(size: 14, weight: .heavy, design: .rounded)).tracking(1.2); Image(systemName: "arrow.right").font(.system(size: 12, weight: .bold)) }
                        .foregroundStyle(.white).padding(.horizontal, 22).padding(.vertical, 12).background(Capsule().fill(task.isFrog ? Color.green : Color(red: 0.36, green: 0.36, blue: 0.84))).shadow(color: (task.isFrog ? Color.green : Color.blue).opacity(0.30), radius: 10, x: 0, y: 6)
                    }.buttonStyle(.plain).keyboardShortcut(.defaultAction).accessibilityLabel("Start focus on \(task.title)").accessibilityIdentifier("action-button").accessibilityAddTraits(.isButton)
                }
            }.padding(.vertical, 4).animation(.easeInOut(duration: 0.35), value: vm.isActive).animation(.easeInOut(duration: 0.35), value: vm.isPaused).animation(.easeInOut(duration: 0.35), value: vm.isOvertime)
            if vm.isActive || vm.isPaused {
                if !vm.breakPickerVisible && !vm.isOnBreak {
                    Button(action: { vm.breakPickerVisible = true }) {
                        Label("Take Break — leave the Mac", systemImage: "cup.and.saucer")
                            .font(.system(size: 11, weight: .medium, design: .rounded))
                            .foregroundStyle(Color.teal)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(Capsule().fill(Color.teal.opacity(0.10)))
                            .overlay(Capsule().stroke(Color.teal.opacity(0.18), lineWidth: 1))
                    }.buttonStyle(.plain)
                }
            }
            if !vm.isOnBreak && !vm.flowPickerVisible {
                Button(action: { vm.openBreakdown() }) {
                    Label("Break down into next actions", systemImage: "list.bullet.indent")
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundStyle(Color.indigo)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Capsule().fill(Color.indigo.opacity(0.08)))
                        .overlay(Capsule().stroke(Color.indigo.opacity(0.15), lineWidth: 1))
                }.buttonStyle(.plain)
            }
            if !(vm.isActive || vm.isPaused || vm.isOvertime) {
                Text("Tap ACTION to start. The timer counts from \(task.durationMinutes) minutes — it will persist if Tsurfing restarts. Pause is low friction; overtime counts separately.")
                    .font(.system(size: 11, weight: .regular)).foregroundStyle(.secondary).lineLimit(3)
            } else if vm.isPaused {
                Text("Paused — elapsed frozen. Resume to continue, or add time. Hold to complete (Frog 5s, others 3s).").font(.system(size: 11, weight: .regular)).foregroundStyle(.secondary)
            } else if vm.isOvertime {
                Text("Overtime — planned time elapsed. Keep flowing or add +5/+15/+30. Hold to complete when done.").font(.system(size: 11, weight: .medium)).foregroundStyle(Color.orange)
            } else {
                Text("Focusing — hold to mark complete (Frog 5s).").font(.system(size: 11, weight: .regular)).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 18)
        .background(RoundedRectangle(cornerRadius: 14).fill((vm.isActive || vm.isPaused || vm.isOvertime) ? (vm.isOvertime ? Color.orange.opacity(0.06) : Color.blue.opacity(0.04)) : Color.clear))
        .padding(.horizontal, 10)
    }
    private func holdButton(task: GoalflowTask) -> some View {
        let dur = task.isFrog ? "5s" : "3s"
        return ZStack {
            Capsule().fill(task.isFrog ? Color.green : Color.blue).opacity(vm.holding ? 0.12 : 0.0)
            Button(action: {}) {
                HStack(spacing: 6) {
                    Image(systemName: task.isFrog ? "checkmark.circle.fill" : "checkmark.circle").font(.system(size: 12, weight: .bold))
                    Text("Done \(dur)").font(.system(size: 12, weight: .bold, design: .rounded))
                }
                .foregroundStyle(task.isFrog ? Color.green : Color.blue)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(Capsule().stroke(task.isFrog ? Color.green : Color.blue, lineWidth: vm.holding ? 2 : 1.2))
            }
            .buttonStyle(.plain).accessibilityLabel("Hold to complete, \(dur) hold").accessibilityIdentifier("hold-complete-button").accessibilityAddTraits(.isButton)
            .onLongPressGesture(minimumDuration: 0, pressing: { pressing in
                if pressing { vm.beginHold() } else { vm.endHold(cancelled: vm.holdProgress < 1.0) }
            }, perform: {})
            if vm.holding {
                Capsule().stroke(Color.primary.opacity(0.06), lineWidth: 1)
                GeometryReader { geo in
                    Capsule().fill((task.isFrog ? Color.green : Color.blue).opacity(0.18))
                        .frame(width: geo.size.width * CGFloat(vm.holdProgress))
                        .animation(.linear(duration: 0.02), value: vm.holdProgress)
                }
            }
        }.frame(height: 36).animation(.easeOut(duration: 0.2), value: vm.holding)
    }
    private var isGateWall: Bool {
        switch vm.gate {
        case .monthlyPlanningRequired, .dailyPlanningRequired: return true
        default: return false
        }
    }
    private var gateWall: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "calendar.badge.exclamationmark").foregroundStyle(.orange).font(.system(size: 14))
                Text(gateTitle).font(.system(size: 13, weight: .semibold, design: .rounded))
            }
            Text(gateMessage).font(.system(size: 11, weight: .regular)).foregroundStyle(.secondary).lineLimit(3)
            if let counts = gateCounts { Text(counts).font(.system(size: 10, weight: .medium, design: .rounded)).foregroundStyle(.tertiary) }
            Button(action: { vm.openWebPlan() }) {
                HStack(spacing: 6) { Image(systemName: "arrow.up.forward.app"); Text(gateCTA).font(.system(size: 12, weight: .bold, design: .rounded)) }
                .foregroundStyle(.white).padding(.horizontal, 16).padding(.vertical, 8).background(Capsule().fill(Color.blue))
            }.buttonStyle(.plain).accessibilityLabel(gateCTA).accessibilityIdentifier("gate-cta-button")
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
         .background(RoundedRectangle(cornerRadius: 12).fill(Color.orange.opacity(0.08))).padding(10)
    }
    private var gateTitle: String {
        switch vm.gate {
        case .monthlyPlanningRequired(let m, _): return "Monthly planning required — \(m)"
        case .dailyPlanningRequired(_, let over, _): return over.isEmpty ? "Confirm today’s order" : "Resolve overdue"
        default: return ""
        }
    }
    private var gateMessage: String {
        switch vm.gate {
        case .monthlyPlanningRequired(_, let ids): return "Assign each current-month task (\(ids.count)) to an exact day before focus."
        case .dailyPlanningRequired(let date, let over, let ids):
            if !over.isEmpty { return "\(over.count) overdue task(s) must be resolved. Review and reschedule for \(date)." }
            return "Today has \(ids.count) task(s). Review and confirm today’s order in Plan."
        default: return ""
        }
    }
    private var gateCounts: String? {
        switch vm.gate {
        case .monthlyPlanningRequired(_, let ids): return "\(ids.count) month tasks"
        case .dailyPlanningRequired(_, let over, let ids): return over.isEmpty ? "\(ids.count) today" : "\(over.count) overdue • \(ids.count) today"
        default: return nil
        }
    }
    private var gateCTA: String {
        switch vm.gate {
        case .monthlyPlanningRequired: return "Schedule monthly tasks first"
        case .dailyPlanningRequired(_, let over, _): return over.isEmpty ? "Open today’s plan" : "Resolve overdue first"
        default: return "Open plan"
        }
    }
    private func amalgamBanner(text: String) -> some View {
        Text(text).font(.system(size: 10, weight: .semibold, design: .rounded)).tracking(1.2).textCase(.uppercase).foregroundStyle(Color.indigo.opacity(0.85))
            .frame(maxWidth: .infinity).padding(.vertical, 6).background(Color.indigo.opacity(0.07))
    }
    private var trueNorthFooter: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(vm.trueNorth.prefix(2), id: \.id) { tn in
                Text(tn.vision).font(.system(size: 10, weight: .medium, design: .rounded)).foregroundStyle(.secondary).lineLimit(1)
            }
        }.padding(.horizontal, 14).padding(.vertical, 6).frame(maxWidth: .infinity, alignment: .leading)
         .background(Color.primary.opacity(0.04))
    }
    private var empty: some View {
        VStack(spacing: 10) {
            Image(systemName: "checkmark.seal.fill").font(.system(size: 28)).foregroundStyle(.green)
            Text("Everything done").font(.system(size: 16, weight: .semibold, design: .rounded)).foregroundStyle(.green)
            Text(vm.completedTodayCount > 0 ? "\(vm.completedTodayCount) completed today. Quiet — plan tomorrow when ready." : "Quiet — plan tomorrow when ready.")
                .font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }.frame(maxWidth: .infinity).padding(28)
    }
    private var footer: some View {
        HStack {
            Text("Tsurfing • Execution").font(.system(size: 10, weight: .medium, design: .rounded)).foregroundStyle(.tertiary)
            Spacer()
            if vm.queueCount > 0 {
                Text("\(vm.completedTodayCount) / \(vm.completedTodayCount + vm.queueCount)").font(.system(size: 10, weight: .medium, design: .rounded)).foregroundStyle(.secondary)
            }
            let footerText: String = vm.isPaused ? "Paused" : vm.isOvertime ? "Overtime" : vm.isActive ? "Active" : vm.task == nil ? "Done" : "Ready"
            let footerColor: Color = vm.isOvertime ? Color.orange : vm.isPaused ? Color.orange : vm.isActive ? Color.green : vm.task == nil ? Color.green : Color.secondary
            let footerBG: Color = vm.isOvertime ? Color.orange.opacity(0.14) : vm.isPaused ? Color.orange.opacity(0.12) : vm.isActive ? Color.green.opacity(0.14) : vm.task == nil ? Color.green.opacity(0.14) : Color.primary.opacity(0.06)
            Text(footerText)
                .font(.system(size: 10, weight: .semibold, design: .rounded)).tracking(0.6).textCase(.uppercase)
                .foregroundStyle(footerColor)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(footerBG)
                .clipShape(Capsule())
        }.padding(.horizontal, 14).padding(.vertical, 10)
    }
    private var rewardOverlay: some View {
        Group {
            if vm.showReward {
                ZStack {
                    Circle().stroke(Color.primary.opacity(0.10), lineWidth: 1).scaleEffect(vm.showReward ? 1.22 : 1.0).opacity(vm.showReward ? 0 : 0.3)
                    Circle().fill(Color.blue.opacity(vm.task?.isFrog == true ? 0.10 : 0.06)).scaleEffect(vm.showReward ? 1.18 : 0.92).opacity(vm.showReward ? 0.5 : 0)
                }.animation(.easeOut(duration: 0.9), value: vm.showReward)
            }
        }
    }
}
private extension Color {
    init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(red: Double((v >> 16) & 0xFF)/255, green: Double((v >> 8) & 0xFF)/255, blue: Double(v & 0xFF)/255)
    }
}
