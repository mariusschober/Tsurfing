import SwiftUI

@main
struct GoalflowMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @State private var showAccount = false

    var body: some Scene {
        // MenuBarExtra is SwiftUI-native but we use AppKit controller for Tahoe control.
        // Keep a Settings scene for future preferences.
        Settings {
            VStack(spacing: 16) {
                Text("Tsurfing — Execution Companion")
                    .font(.headline)
                Toggle("Launch at login", isOn: .init(
                    get: { LoginItemService.shared.isEnabled },
                    set: { LoginItemService.shared.setEnabled($0) }
                )).toggleStyle(.switch)
                Text("Version \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown")) • \(MacCloudConfiguration.current.environment.capitalized)")
                    .font(.caption2).foregroundStyle(.tertiary)
                Text(MacCloudConfiguration.current.apiOrigin?.host ?? "Cloud not configured")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Account / Sign in…") { showAccount = true }
                Button("Check for Updates…") { UpdaterService.shared.checkForUpdates() }
                    .buttonStyle(.bordered).controlSize(.small)
                Button("Quit Tsurfing") { NSApplication.shared.terminate(nil) }
                    .keyboardShortcut("q")
            }
            .padding(20)
            .frame(width: 360)
            .sheet(isPresented: $showAccount) {
                SignInView(accountMode: true, onClose: { showAccount = false })
            }
        }
    }
}
