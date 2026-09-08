import Foundation

final class DeviceIdStore: @unchecked Sendable {
    private let defaults: UserDefaults
    private let key = "goalflow-device-id"
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    var deviceId: String {
        if let existing = defaults.string(forKey: key), !existing.isEmpty { return existing }
        let nid = UUID().uuidString
        defaults.set(nid, forKey: key)
        return nid
    }
}
