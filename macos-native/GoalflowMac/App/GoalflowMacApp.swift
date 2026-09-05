import SwiftUI

@main
struct GoalflowMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate

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
                Text("Version 0.4.0 (3) • Tahoe 26 • Sync parity 2")
                    .font(.caption2).foregroundStyle(.tertiary)
                Button("Check for Updates…") { UpdaterService.shared.checkForUpdates() }
                    .buttonStyle(.bordered).controlSize(.small)
                Button("Quit Tsurfing") { NSApplication.shared.terminate(nil) }
                    .keyboardShortcut("q")
            }
            .padding(20)
            .frame(width: 360)
        }
    }
}
