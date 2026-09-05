import AppKit
import SwiftUI
import Combine
import QuartzCore

@MainActor
final class CaptureWindowController: NSObject {
    private var panel: NSPanel?
    private var viewModel: CaptureViewModel?
    private var taskProvider: DemoCurrentTaskProvider?
    private var store: (any FocusSessionStore)?
    private var clock: (any Clock)?
    private var executionVM: ExecutionViewModel?
    private var cancellables = Set<AnyCancellable>()
    private var monitor: Any?

    func configure(taskProvider: DemoCurrentTaskProvider, store: any FocusSessionStore, clock: any Clock, executionVM: ExecutionViewModel, taskStore: any TaskStore) {
        self.taskProvider = taskProvider
        self.store = store
        self.clock = clock
        self.executionVM = executionVM
        let capService = LocalCaptureService(taskStore: taskStore, clock: clock)
        let vm = CaptureViewModel(taskStore: taskStore, captureService: capService, clock: clock, privacy: ScreenSharingPrivacyGateway())
        vm.onCreated = { [weak self] task, intent in
            self?.handleCreated(task: task, intent: intent)
        }
        self.viewModel = vm
    }

    func show() {
        guard let vm = viewModel else { return }
        // Don't show capture during break cover
        if executionVM?.isOnBreak == true { return }
        vm.checkPrivacy()
        ensurePanel()
        guard let panel = panel else { return }
        // Center on active screen
        if let screen = NSScreen.main ?? NSScreen.screens.first {
            let frame = screen.visibleFrame
            let size = panel.frame.size
            let origin = NSPoint(x: frame.midX - size.width/2, y: frame.midY - size.height/2 + 60)
            panel.setFrameOrigin(origin)
        }
        let start = CACurrentMediaTime()
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.async {
            panel.makeFirstResponder(panel.contentView)
            let elapsed = (CACurrentMediaTime() - start) * 1000
            if elapsed > 200 { print("[Capture] show \(Int(elapsed))ms >200") }
        }
    }

    func hide() {
        panel?.orderOut(nil)
        viewModel?.cancel()
        if let m = monitor { NSEvent.removeMonitor(m); monitor = nil }
    }

    func toggle() {
        if panel?.isVisible == true { hide() } else { show() }
    }

    private func ensurePanel() {
        if panel != nil { return }
        guard let vm = viewModel else { return }
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 520, height: 260),
                        styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.isFloatingPanel = true
        p.level = .floating
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.backgroundColor = .clear
        p.isOpaque = false
        p.hasShadow = true
        p.isMovableByWindowBackground = true
        let hosting = NSHostingView(rootView: CaptureOverlayView(vm: vm, onDismiss: { [weak self] in self?.hide() }))
        hosting.frame = p.contentRect(forFrameRect: p.frame)
        p.contentView = hosting
        // Esc observer (stored for removal)
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 { // Esc
                self?.hide()
                return nil
            }
            return event
        }
        self.panel = p
    }

    deinit { if let m = monitor { NSEvent.removeMonitor(m) } }
    private func handleCreated(task: GoalflowTask, intent: CaptureIntent) {
        executionVM?.restore()
        if intent == .action {
            if executionVM?.isActive == true || executionVM?.isPaused == true {
                print("[Capture] ACTION deferred—already in flow, kept as ADD")
                return
            }
            // Only auto-start when scheduledFor == today and is day precision
            let today = makeTodayString(from: clock?.now() ?? Date())
            guard task.schedulePrecision == .day, task.scheduledFor == today else {
                print("[Capture] ACTION for future-month kept as ADD (needs planning)")
                return
            }
            startFocus(for: task)
        }
    }

    private func startFocus(for task: GoalflowTask) {
        guard let store = store, let clock = clock, let evm = executionVM else { return }
        // Only start if task is open and not already started
        if evm.isActive || evm.isPaused { return }
        let mono: UInt64? = (clock as? any MonotonicClock)?.monotonicNow
        let state = ExecutionState(taskId: task.id, phase: .active, startedAt: clock.now(), startedAtMonotonic: mono, plannedDurationSeconds: task.plannedDurationSeconds)
        do {
            try store.save(state)
            evm.restore() // will pick up new execution
        } catch {
            evm.reportCaptureStartFailure(error)
        }
    }
}
