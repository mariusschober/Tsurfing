import Foundation
import AppKit
#if canImport(Sparkle)
import Sparkle
final class UpdaterService: NSObject, @unchecked Sendable {
    static let shared = UpdaterService()
    private let updater: SPUStandardUpdaterController
    override init() {
        updater = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        super.init()
    }
    func checkForUpdates() { updater.checkForUpdates(nil) }
}
#else
final class UpdaterService: @unchecked Sendable {
    static let shared = UpdaterService()
    func checkForUpdates() {
        // Fallback: open appcast URL
        if let url = URL(string: "https://app.tsurfing.com/appcast.xml") {
            NSWorkspace.shared.open(url)
        }
        // Also check via simple URLSession for version
        Task {
            guard let feed = URL(string: "https://app.tsurfing.com/appcast.xml") else { return }
            if let (_, resp) = try? await URLSession.shared.data(from: feed),
               let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                print("[Updater] Feed reachable")
            }
        }
    }
}
#endif
