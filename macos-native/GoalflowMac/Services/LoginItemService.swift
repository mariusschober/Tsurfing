import Foundation
import ServiceManagement

final class LoginItemService: ObservableObject, @unchecked Sendable {
    static let shared = LoginItemService()
    @Published var isEnabled: Bool {
        didSet { guard oldValue != isEnabled else { return }; Task { await setEnabled(isEnabled) } }
    }
    init() {
        if #available(macOS 13.0, *) {
            isEnabled = SMAppService.mainApp.status == .enabled
        } else {
            isEnabled = false
        }
    }
    @MainActor
    func setEnabled(_ enabled: Bool) {
        if #available(macOS 13.0, *) {
            do {
                if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            } catch {
                print("[LoginItem] failed \(error)")
            }
            let newStatus = SMAppService.mainApp.status == .enabled
            if isEnabled != newStatus { isEnabled = newStatus }
        }
    }
}
