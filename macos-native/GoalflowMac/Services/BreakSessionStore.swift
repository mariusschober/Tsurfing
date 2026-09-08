import Foundation

final class BreakSessionStore: @unchecked Sendable {
    private let fileURL: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(fileURL: URL? = nil) {
        if let u = fileURL {
            self.fileURL = u
        } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
            let dir = base.appendingPathComponent("com.mariusschober.GoalflowMac", isDirectory: true)
            self.fileURL = dir.appendingPathComponent("break.json")
        }
        self.encoder = JSONEncoder()
        self.encoder.dateEncodingStrategy = .secondsSince1970
        self.encoder.outputFormatting = [.sortedKeys]
        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .secondsSince1970
    }

    private func ensureDirectory() throws {
        let dir = fileURL.deletingLastPathComponent()
        if !FileManager.default.fileExists(atPath: dir.path) {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
    }

    func load() throws -> BreakState? {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return nil }
        do {
            let data = try Data(contentsOf: fileURL)
            return try decoder.decode(BreakState.self, from: data)
        } catch { throw FocusSessionStoreError.corrupted("the break-state file cannot be decoded") }
    }

    func save(_ state: BreakState) throws {
        try ensureDirectory()
        let data = try encoder.encode(state)
        do { try data.write(to: fileURL, options: [.atomic]) } catch { throw FocusSessionStoreError.writeFailed(error.localizedDescription) }
        guard let read = try? Data(contentsOf: fileURL) else { throw FocusSessionStoreError.writeFailed("missing after atomic write") }
        if read != data { throw FocusSessionStoreError.readBackMismatch }
        let decoded = try decoder.decode(BreakState.self, from: read)
        if decoded.durationSeconds != state.durationSeconds
            || decoded.sourcePhase != state.sourcePhase
            || decoded.taskId != state.taskId
            || abs(decoded.startedAt.timeIntervalSince(state.startedAt)) > 0.001
            || decoded.startedAtMonotonic != state.startedAtMonotonic {
            throw FocusSessionStoreError.readBackMismatch
        }
    }

    func clear() throws {
        if FileManager.default.fileExists(atPath: fileURL.path) {
            do { try FileManager.default.removeItem(at: fileURL) } catch { throw FocusSessionStoreError.writeFailed(error.localizedDescription) }
        }
    }

    var url: URL { fileURL }
}
