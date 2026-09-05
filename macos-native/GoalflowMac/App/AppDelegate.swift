import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var menuBar: MenuBarController?
    private var hotkey: (any HotkeyGateway)?
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

    func applicationWillTerminate(_ notification: Notification) {
        menuBar?.stop()
        hotkey?.unregister()
    }
}
