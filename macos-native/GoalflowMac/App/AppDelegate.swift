import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    static weak var current: AppDelegate?
    private var menuBar: MenuBarController?
    private var hotkey: CarbonHotkeyGateway?
    private var settingsWindow: NSWindow?
    private let supabaseAuth = SupabaseAuthService.shared

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "tsurfing" && url.host == "auth" && url.path == "/callback" {
            Task {
                do {
                    _ = try await supabaseAuth.handleCallback(url: url)
                } catch {
                    NotificationCenter.default.post(
                        name: .authDidChange,
                        object: error.localizedDescription
                    )
                }
            }
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        Self.current = self
        NSApp.setActivationPolicy(.accessory)

        let store = CompositeFocusSessionStore(
            fileStore: FileFocusSessionStore(),
            walStore: UserDefaultsFocusSessionStore()
        )
        // A production build starts with the real local workspace. Demo data
        // is never seeded implicitly and cloud state is shown separately.
        let provider = DemoCurrentTaskProvider()
        let clock: any Clock = SystemClock()
        let dailyPlanStore = DailyPlanStore()
        let goalStore = GoalStore()
        let trueNorthStore = TrueNorthStore()
        let amalgamStore = AmalgamStore()

        let mb = MenuBarController()
        mb.start(taskProvider: provider, store: store, clock: clock, dailyPlanStore: dailyPlanStore, goalStore: goalStore, trueNorthStore: trueNorthStore, amalgamStore: amalgamStore, gateEnabled: true)
        menuBar = mb

        // Global capture hotkey Cmd+Shift+G
        let hk = CarbonHotkeyGateway()
        hk.register { [weak self] in
            Task { @MainActor in self?.menuBar?.toggleCapture() }
        }
        hotkey = hk
    }

    func updateCaptureShortcut(_ shortcut: CaptureShortcut) -> String? {
        guard shortcut.isValid else { return "Choose Command, Control, or Option with a letter." }
        if shortcut == CaptureShortcut.load() { return nil }
        guard let hotkey, hotkey.update(shortcut) == 0 else {
            return "That shortcut is unavailable. Your previous shortcut still works."
        }
        shortcut.save()
        return nil
    }

    func showSettings() {
        if settingsWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 430, height: 520),
                styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Tsurfing Settings"
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: TsurfingSettingsView())
            window.center()
            settingsWindow = window
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        menuBar?.stop()
        hotkey?.unregister()
    }
}
