import SwiftUI

@main
struct GoalflowMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    var body: some Scene {
        Settings { TsurfingSettingsView() }
    }
}

struct TsurfingSettingsView: View {
    @State private var shortcut = CaptureShortcut.load()
    @State private var saved = CaptureShortcut.load()
    @State private var message: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Keyboard shortcuts").font(.title2.bold())
            Text("Quick Capture · \(saved.label)").font(.headline)
            Text("Opens Quick Capture from any app. This is Tsurfing’s only global shortcut.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Toggle("⌘", isOn: $shortcut.command).help("Command")
                Toggle("⇧", isOn: $shortcut.shift).help("Shift")
                Toggle("⌥", isOn: $shortcut.option).help("Option")
                Toggle("⌃", isOn: $shortcut.control).help("Control")
                Picker("Key", selection: $shortcut.key) {
                    ForEach(CaptureShortcut.keys, id: \.0) { key in Text(key.0).tag(key.0) }
                }.frame(width: 90)
            }.toggleStyle(.checkbox)
            HStack {
                Button("Restore Default") { shortcut = CaptureShortcut(); apply() }
                Spacer()
                Button("Save Shortcut", action: apply).disabled(!shortcut.isValid || shortcut == saved)
                    .buttonStyle(.borderedProminent)
            }
            if let message { Text(message).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            Divider()
            Text("In Quick Capture").font(.headline)
            Text("Return: add task\n⌘Return: show notes\n⌘⇧Return: add and start\nEsc: dismiss")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Toggle("Launch at login", isOn: .init(
                get: { LoginItemService.shared.isEnabled },
                set: { LoginItemService.shared.setEnabled($0) }
            ))
            Button("Check for Updates…") { UpdaterService.shared.checkForUpdates() }
        }
        .padding(24).frame(width: 430)
    }
    private func apply() {
        guard let delegate = AppDelegate.current else { return }
        if let error = delegate.updateCaptureShortcut(shortcut) { message = error }
        else { saved = shortcut; message = "Shortcut saved: \(saved.label)" }
    }
}
