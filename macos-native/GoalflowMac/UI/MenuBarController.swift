import AppKit
import SwiftUI
import Combine
import os
private let menuBarLogger = Logger(subsystem: "com.mariusschober.tsurfing.mac", category: "MenuBar")
@MainActor
final class MenuBarController: NSObject {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var viewModel: ExecutionViewModel!
    private var taskProvider: DemoCurrentTaskProvider!
    private var breakCover = BreakCoverWindowController()
    private var captureController: CaptureWindowController?
    private var store: (any FocusSessionStore)?
    private var clock: (any Clock)?
    private var cancellables: Set<AnyCancellable> = []
    override init() { super.init() }
    func start(taskProvider: DemoCurrentTaskProvider, store: any FocusSessionStore, clock: any Clock = SystemClock(), dailyPlanStore: DailyPlanStore = DailyPlanStore(), goalStore: GoalStore = GoalStore(), trueNorthStore: TrueNorthStore = TrueNorthStore(), amalgamStore: AmalgamStore = AmalgamStore(), gateEnabled: Bool = false) {
        self.taskProvider = taskProvider; self.store = store; self.clock = clock; self.viewModel = ExecutionViewModel(provider: taskProvider, store: store, clock: clock, dailyPlanStore: dailyPlanStore, goalStore: goalStore, trueNorthStore: trueNorthStore, amalgamStore: amalgamStore, gateEnabled: gateEnabled)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            let img = NSImage(systemSymbolName: "scope", accessibilityDescription: "Tsurfing")
            img?.isTemplate = true
            button.image = img; button.imagePosition = .imageOnly
            button.action = #selector(togglePopover); button.target = self
            button.appearsDisabled = false
            button.appearance = nil // inherit vibrant menu bar appearance (Tahoe Liquid Glass)
            updateStatusTitle()
        }
        popover = NSPopover(); popover.contentSize = NSSize(width: 400, height: 420); popover.behavior = .transient; popover.animates = true
        let hosting = NSHostingView(rootView: ExecutionPanelView(vm: viewModel))
        let vc = NSViewController(); vc.view = hosting; popover.contentViewController = vc
        // Capture controller (lazy, needs viewModel)
        setupCapture()
        viewModel.$remainingSeconds.receive(on: DispatchQueue.main).sink { [weak self] _ in self?.updateStatusTitle() }.store(in: &cancellables)
        viewModel.$overtimeSeconds.receive(on: DispatchQueue.main).sink { [weak self] _ in self?.updateStatusTitle() }.store(in: &cancellables)
        viewModel.$isPaused.receive(on: DispatchQueue.main).sink { [weak self] _ in self?.updateStatusTitle() }.store(in: &cancellables)
        viewModel.$isOnBreak.receive(on: DispatchQueue.main).sink { [weak self] onBreak in self?.handleBreakChange(onBreak: onBreak) }.store(in: &cancellables)
        viewModel.$breakRemaining.receive(on: DispatchQueue.main).sink { [weak self] _ in self?.updateBreakCover(); self?.updateStatusTitle() }.store(in: &cancellables)
        viewModel.$breakElapsed.receive(on: DispatchQueue.main).sink { [weak self] _ in self?.updateBreakCover(); self?.updateStatusTitle() }.store(in: &cancellables)
        NotificationCenter.default.addObserver(self, selector: #selector(appDidBecomeActive), name: NSApplication.didBecomeActiveNotification, object: nil)
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(appearanceDidChange), name: NSNotification.Name("AppleInterfaceThemeChangedNotification"), object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(appearanceDidChange), name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }
    @objc private func togglePopover() {
        // Suppress popover during break — cover is fullscreen
        if viewModel.isOnBreak { return }
        guard let button = statusItem.button else { return }
        if popover.isShown { popover.performClose(nil) } else { viewModel.restore(); updateStatusTitle(); popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY); popover.contentViewController?.view.window?.makeKey() }
    }

    @objc private func appDidBecomeActive() { viewModel.applicationDidBecomeActive(); viewModel.restore(); updateStatusTitle(); if viewModel.isOnBreak { updateBreakCover() } }
    @objc private func appearanceDidChange() { updateStatusTitle() }

    func stop() {
        viewModel?.applicationWillTerminate()
    }

    // MARK: - Capture

    private func setupCapture() {
        guard let store = store, let clock = clock else { return }
        let cap = CaptureWindowController()
        let taskStore: any TaskStore = taskProvider.taskStore
        cap.configure(taskProvider: taskProvider, store: store, clock: clock, executionVM: viewModel, taskStore: taskStore)
        captureController = cap
    }

    func toggleCapture() { captureController?.toggle() }
    func showCapture() { captureController?.show() }

    @objc private func handleCaptureMenu() { showCapture() }

    private func handleBreakChange(onBreak: Bool) {
        if onBreak {
            if popover.isShown { popover.performClose(nil) }
            guard let bs = viewModel.breakState else { return }
            breakCover.show(breakState: bs, onEndEarly: { [weak self] in self?.viewModel.endBreakEarly() })
            updateBreakCover()
            // Ensure alarm will fire via ViewModel's breakTimer -> sound
        } else {
            breakCover.closeAll()
        }
        updateStatusTitle()
    }

    private func updateBreakCover() {
        guard viewModel.isOnBreak else { return }
        breakCover.update(remainingSeconds: viewModel.breakRemaining, elapsedSeconds: viewModel.breakElapsed)
    }
    private func updateStatusTitle() {
        guard let button = statusItem.button else { return }
        button.appearsDisabled = false
        // Tahoe: menu bar is transparent Liquid Glass — isDark must reflect system dark, not NSApp aqua fallback
        // Use AppleInterfaceStyle + button.window appearance + effectiveAppearance
        let isDark: Bool = {
            if let style = UserDefaults.standard.string(forKey: "AppleInterfaceStyle"), style == "Dark" { return true }
            if let winAppearance = button.window?.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua, .vibrantDark, .vibrantLight]) {
                return winAppearance == .vibrantDark || winAppearance == .darkAqua
            }
            return NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        }()
        #if DEBUG
        let debugAppearance = button.effectiveAppearance.name.rawValue
        let winAppearance = button.window?.effectiveAppearance.name.rawValue ?? "nil-window"
        let appAppearance = NSApp.effectiveAppearance.name.rawValue
        menuBarLogger.debug("[MenuBar] isDark=\(isDark, privacy: .public) button.effective=\(debugAppearance, privacy: .public) window=\(winAppearance, privacy: .public) app=\(appAppearance, privacy: .public)")
        #endif
        button.appearance = NSAppearance(named: isDark ? .vibrantDark : .vibrantLight)
        // Break takes precedence — show break timer
        if viewModel.isOnBreak {
            let remaining = viewModel.breakRemaining
            let elapsed = viewModel.breakElapsed
            let timeStr: String
            if let r = remaining {
                timeStr = String(format: "%02d:%02d", r/60, r%60)
            } else {
                timeStr = String(format: "%02d:%02d", elapsed/60, elapsed%60)
            }
            let title = "☕ \(timeStr)"
            button.attributedTitle = NSAttributedString(string: title, attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .medium), .foregroundColor: NSColor.systemTeal])
            button.imagePosition = .imageLeading
            let img = NSImage(systemSymbolName: "cup.and.saucer.fill", accessibilityDescription: nil)
            img?.isTemplate = true
            button.image = img
            button.toolTip = "On Break — \(timeStr)"
            button.contentTintColor = .systemTeal
            return
        }
        // Respect planning gate when enabled
        if case .monthlyPlanningRequired = viewModel.gate {
            button.attributedTitle = NSAttributedString(string: "Plan monthly", attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .medium), .foregroundColor: NSColor.systemOrange])
            button.imagePosition = .imageLeading
            let img = NSImage(systemSymbolName: "calendar.badge.exclamationmark", accessibilityDescription: nil); img?.isTemplate = true; button.image = img
            button.toolTip = "Monthly planning required"; button.contentTintColor = .systemOrange; return
        }
        if case .dailyPlanningRequired = viewModel.gate {
            button.attributedTitle = NSAttributedString(string: "Plan the day", attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .medium), .foregroundColor: NSColor.systemOrange])
            button.imagePosition = .imageLeading
            let img = NSImage(systemSymbolName: "calendar.badge.exclamationmark", accessibilityDescription: nil); img?.isTemplate = true; button.image = img
            button.toolTip = "Daily planning required"; button.contentTintColor = .systemOrange; return
        }
        let task = viewModel.task
        let isPaused = viewModel?.isPaused ?? false; let isOvertime = viewModel?.isOvertime ?? false; let isActive = viewModel?.isActive ?? false
        let display: String
        if let t = task {
            let trimmed = t.title.count > 22 ? String(t.title.prefix(22)) + "…" : t.title
            if isPaused { display = "⏸ \(trimmed) \(viewModel?.displayTime ?? "")" }
            else if isOvertime { display = "● \(trimmed) \(viewModel?.displayTime ?? "")" }
            else if isActive { display = "● \(trimmed) \(viewModel?.displayTime ?? "")" }
            else { display = trimmed }
        } else { display = "Plan the day" }
        let iconName = isPaused ? "pause.circle.fill" : isOvertime ? "exclamationmark.circle.fill" : isActive ? "scope" : "circle.dotted"
        let baseColor: NSColor = .systemRed
        button.attributedTitle = NSAttributedString(string: display, attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .medium), .foregroundColor: baseColor])
        button.imagePosition = .imageLeading
        let icon = NSImage(systemSymbolName: iconName, accessibilityDescription: nil)
        icon?.isTemplate = true
        button.image = icon
        button.toolTip = task?.title ?? "Tsurfing — no tasks planned"
        button.contentTintColor = baseColor
    }
}
