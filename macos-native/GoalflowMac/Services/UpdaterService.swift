import Foundation
import AppKit
#if canImport(Sparkle)
import Sparkle
#endif

final class UpdaterService: NSObject, @unchecked Sendable {
    static let shared = UpdaterService()
    #if canImport(Sparkle)
    private let updater: SPUStandardUpdaterController
    override init() {
        updater = SPUStandardUpdaterController(
            startingUpdater: MacCloudConfiguration.current.environment == "production",
            updaterDelegate: nil, userDriverDelegate: nil
        )
        super.init()
    }
    #endif

    @MainActor func checkForUpdates() {
        let configuration = MacCloudConfiguration.current
        guard configuration.environment == "production" else {
            let alert = NSAlert()
            alert.messageText = "Staging build"
            alert.informativeText = "Staging updates are installed locally. This build does not use the production update channel."
            alert.runModal()
            return
        }
        #if canImport(Sparkle)
        updater.checkForUpdates(nil)
        #else
        guard let origin = configuration.apiOrigin else { return }
        NSWorkspace.shared.open(origin.appendingPathComponent("appcast.xml"))
        #endif
    }
}
