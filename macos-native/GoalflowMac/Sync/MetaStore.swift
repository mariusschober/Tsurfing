import Foundation
import CryptoKit

struct DurableLocalWrite: Codable, Equatable, Sendable {
    let fileName: String
    let walKey: String
    let data: Data?
    let checksum: String

    init(fileName: String, walKey: String, data: Data?) {
        self.fileName = fileName
        self.walKey = walKey
        self.data = data
        self.checksum = Self.sha256(data ?? Data())
    }

    var isDeletion: Bool { data == nil }
    var hasValidChecksum: Bool { checksum == Self.sha256(data ?? Data()) }

    private static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

enum LocalCommitStage: Equatable, Sendable {
    case journalDurable
    case localReplicaWritten(Int)
    case metaReplicasWritten
}

private struct LocalCommitJournal: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let id: String
    let writes: [DurableLocalWrite]
    let syncMetaData: Data
    let syncMetaChecksum: String
    let createdAt: String
}

final class SyncMetaStore: @unchecked Sendable {
    private static let persistenceLock = NSRecursiveLock()
    let fileURL: URL
    private let walKey: String
    private let journalWalKey: String
    private let journalURL: URL
    private let defaults: UserDefaults
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let failureInjector: ((LocalCommitStage) throws -> Void)?

    init(
        fileURL: URL? = nil,
        defaults: UserDefaults = .standard,
        walKey: String = "goalflow.sync.meta.v2",
        failureInjector: ((LocalCommitStage) throws -> Void)? = nil
    ) {
        if let u = fileURL { self.fileURL = u } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
            let dir = base.appendingPathComponent("com.mariusschober.GoalflowMac", isDirectory: true)
            self.fileURL = dir.appendingPathComponent("sync.json")
        }
        self.defaults = defaults
        self.walKey = walKey
        self.failureInjector = failureInjector
        self.journalWalKey = "\(walKey).local-commit.v1"
        self.journalURL = self.fileURL.appendingPathExtension("local-commit.json")
        encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; encoder.dateEncodingStrategy = .iso8601
        decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
    }

    private func ensureDirectory() throws {
        let dir = fileURL.deletingLastPathComponent()
        if !FileManager.default.fileExists(atPath: dir.path) { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
    }

    func load() throws -> SyncMeta {
        try withLock {
            try recoverPendingLocalCommit()
            return try loadWithoutRecovery()
        }
    }

    func save(_ meta: SyncMeta) throws {
        try withLock {
            try recoverPendingLocalCommit()
            try writeMetaReplicas(encoder.encode(normalizeSyncMeta(meta)))
        }
    }

    func loadLocalValue<Value>(
        fileURL localFileURL: URL,
        walKey localWalKey: String,
        decode: (Data) throws -> Value
    ) throws -> Value? {
        try withLock {
            try recoverPendingLocalCommit()
            let target = try makeLocalWrite(fileURL: localFileURL, walKey: localWalKey, data: Data())
            let targetURL = self.fileURL.deletingLastPathComponent().appendingPathComponent(target.fileName)
            let fileExists = FileManager.default.fileExists(atPath: targetURL.path)
            let fileData: Data?
            if fileExists { fileData = try? Data(contentsOf: targetURL) }
            else { fileData = nil }
            let mirrorData = defaults.data(forKey: localWalKey)

            if let fileData, let value = try? decode(fileData) {
                if mirrorData != fileData { try writeLocalReplicas(DurableLocalWrite(fileName: target.fileName, walKey: localWalKey, data: fileData)) }
                return value
            }
            if let mirrorData, let value = try? decode(mirrorData) {
                try writeLocalReplicas(DurableLocalWrite(fileName: target.fileName, walKey: localWalKey, data: mirrorData))
                return value
            }
            if !fileExists && mirrorData == nil { return nil }
            throw SyncError.corruptStorage("Local \(target.fileName) data is damaged. Nothing was deleted or replaced; restore a valid replica before continuing.")
        }
    }

    func commitLocalValue(
        fileURL localFileURL: URL,
        walKey localWalKey: String,
        data: Data,
        nextMeta: SyncMeta
    ) throws {
        let write = try makeLocalWrite(fileURL: localFileURL, walKey: localWalKey, data: data)
        try commitLocalValues([write], nextMeta: nextMeta)
    }

    func commitLocalValues(_ writes: [DurableLocalWrite], nextMeta: SyncMeta) throws {
        try withLock {
            try recoverPendingLocalCommit()
            guard !writes.isEmpty,
                  Set(writes.map(\.fileName)).count == writes.count,
                  Set(writes.map(\.walKey)).count == writes.count else {
                throw SyncError.validation("The local commit did not contain unique durable targets.")
            }
            for write in writes { try validate(write) }
            let metaData = try encoder.encode(normalizeSyncMeta(nextMeta))
            let journal = LocalCommitJournal(
                schemaVersion: 1,
                id: UUID().uuidString.lowercased(),
                writes: writes,
                syncMetaData: metaData,
                syncMetaChecksum: sha256(metaData),
                createdAt: ISO8601DateFormatter().string(from: Date())
            )
            try writeJournalReplicas(encoder.encode(journal))
            try failureInjector?(.journalDurable)
            // The journal is durable before either side changes. A process
            // death at any following instruction is completed on next load.
            for (index, write) in writes.enumerated() {
                try writeLocalReplicas(write)
                try failureInjector?(.localReplicaWritten(index))
            }
            try writeMetaReplicas(metaData)
            try failureInjector?(.metaReplicasWritten)
            try clearJournalReplicas()
        }
    }

    func bindingState(for userId: String) throws -> WorkspaceBindingState {
        guard UUID(uuidString: userId) != nil else {
            throw SyncError.validation("The verified account identity is invalid.")
        }
        guard let bound = try load().accountUserId else { return .unbound }
        return bound == userId.lowercased() ? .bound : .differentAccount
    }

    func bind(to userId: String) throws {
        try withLock {
            guard UUID(uuidString: userId) != nil else {
                throw SyncError.validation("The verified account identity is invalid.")
            }
            try recoverPendingLocalCommit()
            var meta = try loadWithoutRecovery()
            let normalizedUserId = userId.lowercased()
            if let existing = meta.accountUserId, existing != normalizedUserId {
                throw SyncError.accountMismatch
            }
            meta.accountUserId = normalizedUserId
            try writeMetaReplicas(encoder.encode(normalizeSyncMeta(meta)))
        }
    }

    private func loadWithoutRecovery() throws -> SyncMeta {
        let fileExists = FileManager.default.fileExists(atPath: fileURL.path)
        let fileData: Data?
        if fileExists { fileData = try? Data(contentsOf: fileURL) }
        else { fileData = nil }
        let walData = defaults.data(forKey: walKey)

        if let fileData, let meta = decodeAndNormalize(fileData) {
            let canonical = try encoder.encode(meta)
            if fileData != canonical || walData != canonical {
                try writeMetaReplicas(canonical)
            }
            return meta
        }
        if let walData, let meta = decodeAndNormalize(walData) {
            try writeMetaReplicas(encoder.encode(meta))
            return meta
        }
        if !fileExists && walData == nil { return emptySyncMeta() }
        throw SyncError.corruptStorage("Synchronization metadata is damaged. Local changes were not deleted; recovery is required before synchronization can continue.")
    }

    private func decodeAndNormalize(_ data: Data) -> SyncMeta? {
        guard let decoded = try? decoder.decode(SyncMeta.self, from: data) else { return nil }
        return try? normalizeSyncMeta(decoded)
    }

    private func writeMetaReplicas(_ data: Data) throws {
        try ensureDirectory()
        do { try data.write(to: fileURL, options: [.atomic]) } catch { throw SyncError.writeFailed(error.localizedDescription) }
        guard let read = try? Data(contentsOf: fileURL) else { throw SyncError.writeFailed("missing after write") }
        if read != data { throw SyncError.readBackMismatch }
        defaults.set(data, forKey: walKey)
        guard defaults.synchronize(), defaults.data(forKey: walKey) == data else {
            throw SyncError.writeFailed("the synchronization metadata mirror did not become durable")
        }
    }

    private func makeLocalWrite(fileURL localFileURL: URL, walKey localWalKey: String, data: Data) throws -> DurableLocalWrite {
        let parent = localFileURL.standardizedFileURL.deletingLastPathComponent()
        guard parent == fileURL.standardizedFileURL.deletingLastPathComponent(),
              !localFileURL.lastPathComponent.isEmpty,
              !localFileURL.lastPathComponent.contains("/"),
              Self.allowedLocalWalKeys.contains(localWalKey) else {
            throw SyncError.validation("The local persistence target is not part of the Tsurfing workspace.")
        }
        return DurableLocalWrite(fileName: localFileURL.lastPathComponent, walKey: localWalKey, data: data)
    }

    private func validate(_ write: DurableLocalWrite) throws {
        guard write.hasValidChecksum,
              !write.fileName.isEmpty,
              !write.fileName.contains("/"),
              write.fileName != fileURL.lastPathComponent,
              write.fileName != journalURL.lastPathComponent,
              Self.allowedLocalWalKeys.contains(write.walKey) else {
            throw SyncError.corruptStorage("A pending local commit is damaged. Nothing was discarded; recovery requires operator review.")
        }
    }

    private func writeLocalReplicas(_ write: DurableLocalWrite) throws {
        try validate(write)
        try ensureDirectory()
        let targetURL = fileURL.deletingLastPathComponent().appendingPathComponent(write.fileName)
        if let data = write.data {
            do { try data.write(to: targetURL, options: [.atomic]) }
            catch { throw SyncError.writeFailed("local data could not be written") }
            guard (try? Data(contentsOf: targetURL)) == data else { throw SyncError.readBackMismatch }
            defaults.set(data, forKey: write.walKey)
            guard defaults.synchronize(), defaults.data(forKey: write.walKey) == data else {
                throw SyncError.writeFailed("the local data mirror did not become durable")
            }
        } else {
            if FileManager.default.fileExists(atPath: targetURL.path) {
                do { try FileManager.default.removeItem(at: targetURL) }
                catch { throw SyncError.writeFailed("local data could not be removed") }
            }
            defaults.removeObject(forKey: write.walKey)
            guard defaults.synchronize(), defaults.data(forKey: write.walKey) == nil,
                  !FileManager.default.fileExists(atPath: targetURL.path) else {
                throw SyncError.writeFailed("the local deletion did not become durable")
            }
        }
    }

    private func pendingJournal() throws -> LocalCommitJournal? {
        let fileExists = FileManager.default.fileExists(atPath: journalURL.path)
        let fileData: Data?
        if fileExists { fileData = try? Data(contentsOf: journalURL) }
        else { fileData = nil }
        let mirrorData = defaults.data(forKey: journalWalKey)
        if let fileData, let journal = validJournal(fileData) {
            let canonical = try encoder.encode(journal)
            if fileData != canonical || mirrorData != canonical { try writeJournalReplicas(canonical) }
            return journal
        }
        if let mirrorData, let journal = validJournal(mirrorData) {
            try writeJournalReplicas(encoder.encode(journal))
            return journal
        }
        if !fileExists && mirrorData == nil { return nil }
        throw SyncError.corruptStorage("The pending local commit journal is damaged. Nothing was discarded; recovery requires operator review.")
    }

    private func validJournal(_ data: Data) -> LocalCommitJournal? {
        guard let journal = try? decoder.decode(LocalCommitJournal.self, from: data),
              journal.schemaVersion == 1,
              UUID(uuidString: journal.id) != nil,
              !journal.writes.isEmpty,
              Set(journal.writes.map(\.fileName)).count == journal.writes.count,
              Set(journal.writes.map(\.walKey)).count == journal.writes.count,
              journal.syncMetaChecksum == sha256(journal.syncMetaData),
              decodeAndNormalize(journal.syncMetaData) != nil,
              journal.writes.allSatisfy({ (try? validate($0)) != nil }) else { return nil }
        return journal
    }

    private func recoverPendingLocalCommit() throws {
        guard let journal = try pendingJournal() else { return }
        for write in journal.writes { try writeLocalReplicas(write) }
        guard let meta = decodeAndNormalize(journal.syncMetaData) else {
            throw SyncError.corruptStorage("The pending local commit metadata is damaged. Nothing was discarded.")
        }
        try writeMetaReplicas(encoder.encode(meta))
        try clearJournalReplicas()
    }

    private func writeJournalReplicas(_ data: Data) throws {
        try ensureDirectory()
        do { try data.write(to: journalURL, options: [.atomic]) }
        catch { throw SyncError.writeFailed("the local commit journal could not be written") }
        guard (try? Data(contentsOf: journalURL)) == data else { throw SyncError.readBackMismatch }
        defaults.set(data, forKey: journalWalKey)
        guard defaults.synchronize(), defaults.data(forKey: journalWalKey) == data else {
            throw SyncError.writeFailed("the local commit journal mirror did not become durable")
        }
    }

    private func clearJournalReplicas() throws {
        if FileManager.default.fileExists(atPath: journalURL.path) {
            do { try FileManager.default.removeItem(at: journalURL) }
            catch { throw SyncError.writeFailed("the completed local commit journal could not be cleared") }
        }
        defaults.removeObject(forKey: journalWalKey)
        guard defaults.synchronize(), defaults.data(forKey: journalWalKey) == nil,
              !FileManager.default.fileExists(atPath: journalURL.path) else {
            throw SyncError.writeFailed("the completed local commit journal remained pending")
        }
    }

    private func withLock<Value>(_ body: () throws -> Value) rethrows -> Value {
        Self.persistenceLock.lock()
        defer { Self.persistenceLock.unlock() }
        return try body()
    }

    private func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static let allowedLocalWalKeys: Set<String> = [
        "goalflow.demo.tasks.v1",
        "goalflow.daily_plans.v1",
        "goalflow.goals.v1",
        "goalflow.habits.v1",
        "goalflow.truenorth.v1",
        "goalflow.stats.v1",
        "goalflow.progress.v1",
        "goalflow.hashtags.v1",
        "goalflow.accountability.v1",
        "goalflow.amalgam.v1",
        "goalflow.tracking.v1",
        "goalflow.circadian.v1",
        "goalflow.settings.v1",
        "goalflow.task_events.v1"
    ]

    // MARK: - Normalize

    func normalizeSyncMeta(_ meta: SyncMeta) throws -> SyncMeta {
        var m = meta
        if m.schemaVersion == 2 {
            // Schema 2 had no account binding. Preserve every pending mutation
            // and require an explicit first-account link before network use.
            m.schemaVersion = SYNC_META_SCHEMA_VERSION
            m.accountUserId = nil
        }
        guard m.schemaVersion == SYNC_META_SCHEMA_VERSION else {
            throw SyncError.validation("Sync meta schema version invalid. The meta was not changed.")
        }
        if let accountUserId = m.accountUserId {
            guard let uuid = UUID(uuidString: accountUserId),
                  uuid.uuidString.lowercased() == accountUserId.lowercased() else {
                throw SyncError.validation("Sync account binding is invalid. The meta was not changed.")
            }
            m.accountUserId = accountUserId.lowercased()
        }
        guard m.cursor >= 0 else { throw SyncError.validation("Sync meta cursor invalid. The meta was not changed.") }
        // Validate versions
        for (k, v) in m.versions {
            guard v.local >= 0 else { throw SyncError.validation("Sync meta versions invalid. The meta was not changed.") }
            if let s = v.server, s < 0 { throw SyncError.validation("Sync meta versions invalid. The meta was not changed.") }
            _ = k
        }
        // Validate outbox
        let ids = m.outbox.map(\.mutationId)
        if Set(ids).count != ids.count { throw SyncError.validation("Sync outbox contains duplicate mutationId. The meta was not changed.") }
        for item in m.outbox {
            guard !item.mutationId.isEmpty, !item.entityType.isEmpty, !item.entityId.isEmpty, item.version > 0 else {
                throw SyncError.validation("Sync outbox damaged. The meta was not changed.")
            }
        }
        // Legacy snapshot explosion: if outbox has singleton array payload for record-level stores, explode
        var newOutbox: [SyncMutation] = []
        for item in m.outbox {
            if RECORD_LEVEL_STORES.contains(item.entityType) && item.entityId == "singleton",
               let payload = item.payload.value as? [[String: Any]], !payload.isEmpty {
                // Check duplicate ids
                let pids = payload.compactMap { $0["id"] as? String }
                if Set(pids).count != pids.count { throw SyncError.validation("Legacy pending snapshot record has duplicate id. The meta was not changed.") }
                for p in payload {
                    guard let pid = p["id"] as? String, !pid.isEmpty else {
                        throw SyncError.validation("Legacy pending snapshot record has no unique identity. The meta was not changed.")
                    }
                    let key = syncEntityKey(item.entityType, pid)
                    let server = m.versions[key]?.server
                    let newId = deterministicUuid("\(item.mutationId):\(pid)")
                    newOutbox.append(SyncMutation(
                        mutationId: newId,
                        deviceId: item.deviceId,
                        entityType: item.entityType,
                        entityId: pid,
                        baseServerVersion: server,
                        version: item.version, // keep? Actually per-entity version should be recomputed but keep original for now
                        payload: AnyCodable(p),
                        updatedAt: item.updatedAt,
                        deletedAt: (p["deletedAt"] as? String)?.isEmpty == false ? p["deletedAt"] as? String : item.deletedAt,
                        dependsOnMutationId: nil,
                        resolvesConflictId: nil,
                        attemptedAt: nil
                    ))
                }
            } else {
                newOutbox.append(item)
            }
        }
        m.outbox = newOutbox
        // Validate conflicts
        let cids = m.conflicts.map(\.id)
        if Set(cids).count != cids.count { throw SyncError.validation("Sync conflicts duplicate id. The meta was not changed.") }
        let outboxIds = Set(m.outbox.map(\.mutationId))
        for c in m.conflicts {
            if outboxIds.contains(c.id) { throw SyncError.validation("Conflict id collides with outbox. The meta was not changed.") }
        }
        // Cross outbox/conflict mutationId collision
        let historyIds = Set(m.conflicts.flatMap { $0.localHistory.compactMap { ($0.value as? [String: Any])?["mutationId"] as? String } })
        if !historyIds.isDisjoint(with: outboxIds) { throw SyncError.validation("A mutation id refers to different durable local changes. The meta was not changed.") }
        return m
    }

    private func deterministicUuid(_ input: String) -> String {
        let digest = Insecure.SHA1.hash(data: Data(input.utf8))
        let bytes = Array(digest.prefix(16))
        var b = bytes
        b[6] = (b[6] & 0x0F) | 0x50
        b[8] = (b[8] & 0x3F) | 0x80
        let tup = (b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7],b[8],b[9],b[10],b[11],b[12],b[13],b[14],b[15])
        return UUID(uuid: tup).uuidString.lowercased()
    }
}

enum SyncError: Error, LocalizedError {
    case validation(String)
    case writeFailed(String)
    case readBackMismatch
    case corruptStorage(String)
    case bindingRequired
    case accountMismatch
    var errorDescription: String? {
        switch self {
        case .validation(let s): return s
        case .writeFailed(let s): return "Sync meta write failed \(s)"
        case .readBackMismatch: return "Sync meta read-back mismatch"
        case .corruptStorage(let message): return message
        case .bindingRequired: return "Confirm which Tsurfing account owns this local workspace before synchronization. Local changes remain pending."
        case .accountMismatch: return "This local workspace belongs to a different Tsurfing account. Synchronization is blocked; local changes were not modified."
        }
    }
}

enum WorkspaceBindingState: Equatable, Sendable {
    case unbound
    case bound
    case differentAccount
}
