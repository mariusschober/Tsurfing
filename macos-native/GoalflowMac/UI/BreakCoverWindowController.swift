import AppKit
import SwiftUI
import Combine

@MainActor
final class BreakCoverWindowController: NSObject {
    nonisolated(unsafe) private var windows: [NSWindow] = []
    private var cancellables: Set<AnyCancellable> = []
    private var breakState: BreakState?
    private var onEndEarly: (() -> Void)?

    func show(breakState: BreakState, onEndEarly: @escaping () -> Void) {
        self.breakState = breakState
        self.onEndEarly = onEndEarly
        closeAll()
        let screens = NSScreen.screens
        for screen in screens {
            let panel = NSPanel(
                contentRect: screen.frame,
                styleMask: .borderless,
                backing: .buffered,
                defer: false
            )
            panel.level = .screenSaver
            panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
            panel.isOpaque = true
            panel.backgroundColor = NSColor(red: 0.05, green: 0.05, blue: 0.05, alpha: 1)
            panel.hasShadow = false
            panel.isReleasedWhenClosed = false
            panel.hidesOnDeactivate = false
            panel.isMovable = false
            panel.ignoresMouseEvents = false
            // Make it appear on all spaces even when app is LSUIElement
            panel.orderFrontRegardless()
            windows.append(panel)
        }
        // Create SwiftUI overlay - we use first window's contentView as host, but need per-screen content
        // Simpler: each window gets its own hosting view with same BreakOverlayView bound to shared state
        // For now, each window shows same overlay; timer updates via re-render on state change
        NSApp.activate(ignoringOtherApps: true)
        observeScreens()
    }

    func update(remainingSeconds: Int?, elapsedSeconds: Int) {
        for window in windows {
            if let hosting = window.contentView as? NSHostingView<BreakOverlayView> {
                hosting.rootView = BreakOverlayView(
                    remainingSeconds: remainingSeconds,
                    elapsedSeconds: elapsedSeconds,
                    onEndEarly: { [weak self] in self?.triggerEndEarly() }
                )
            } else {
                let view = BreakOverlayView(remainingSeconds: remainingSeconds, elapsedSeconds: elapsedSeconds, onEndEarly: { [weak self] in self?.triggerEndEarly() })
                window.contentView = NSHostingView(rootView: view)
            }
        }
    }

    func closeAll() {
        for w in windows { w.orderOut(nil); w.close() }
        windows.removeAll()
        cancellables.removeAll()
    }

    private func triggerEndEarly() {
        onEndEarly?()
    }

    private func observeScreens() {
        NotificationCenter.default.publisher(for: NSApplication.didChangeScreenParametersNotification)
            .sink { [weak self] _ in
                guard let self, let bs = self.breakState else { return }
                let onEnd = self.onEndEarly
                self.show(breakState: bs, onEndEarly: onEnd ?? {})
                // Need to restore current remaining - caller will call update next tick
            }
            .store(in: &cancellables)
    }

    deinit { for w in windows { w.orderOut(nil) } }
}
