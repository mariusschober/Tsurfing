import Foundation
import CryptoKit

struct ReconciliationUpload {
    let manifest: [String: Any]?
    let chunks: [[String: Any]]

    static func prepare(_ body: Data, historyCount: Int) throws -> ReconciliationUpload {
        if body.count <= 262144 && historyCount <= 1000 { return ReconciliationUpload(manifest: nil, chunks: []) }
        guard body.count <= 4 * 1024 * 1024, historyCount <= 100000 else {
            throw SyncError.validation("Saved reconciliation exceeds the supported 4 MiB or 100,000-entry envelope. The full history remains preserved and needs larger-record recovery.")
        }
        func hash(_ value: Data) -> String { SHA256.hash(data: value).map { String(format: "%02x", $0) }.joined() }
        let parts = stride(from: 0, to: body.count, by: 65536).map { body.subdata(in: $0..<min($0 + 65536, body.count)) }
        let hashes = parts.map(hash)
        let manifest: [String: Any] = ["schemaVersion": 1, "sha256": hash(body), "totalBytes": body.count,
                                      "chunkCount": parts.count, "chunkHashes": hashes]
        var chunks: [[String: Any]] = []
        for (index, chunk) in parts.enumerated() {
            chunks.append(["manifest": manifest, "chunkIndex": index, "chunkSha256": hashes[index],
                           "data": chunk.base64EncodedString()])
        }
        return ReconciliationUpload(manifest: manifest, chunks: chunks)
    }

    static func verifyAck(_ chunk: [String: Any], _ response: Data) throws {
        let ack = try JSONSerialization.jsonObject(with: response)
        let expected: [String: Any] = ["staged": true, "manifest": chunk["manifest"]!,
                                      "chunkIndex": chunk["chunkIndex"]!, "chunkSha256": chunk["chunkSha256"]!]
        guard stableJson(ack) == stableJson(expected) else {
            throw SyncError.validation("Reconciliation staging did not acknowledge the exact chunk. The full history remains saved.")
        }
    }
}

func parsePushReceiptRecord(_ value: Any?) -> RemoteRecord? {
    guard let object = value as? [String: Any],
          let entityType = (object["entityType"] ?? object["entity_type"]) as? String,
          !entityType.isEmpty,
          let entityId = (object["entityId"] ?? object["entity_id"]) as? String,
          !entityId.isEmpty,
          object.keys.contains("payload") else { return nil }
    guard let version = strictJSONInteger(object["version"]), version > 0,
          let serverVersion = strictJSONInteger(object["serverVersion"] ?? object["server_version"]), serverVersion > 0 else {
        return nil
    }
    let deviceValue = object["deviceId"] ?? object["device_id"]
    let updatedValue = object["updatedAt"] ?? object["updated_at"]
    let deletedValue = object["deletedAt"] ?? object["deleted_at"]
    guard deviceValue == nil || deviceValue is NSNull || ((deviceValue as? String)?.isEmpty == false),
          updatedValue == nil || updatedValue is NSNull || ((updatedValue as? String)?.isEmpty == false),
          deletedValue == nil || deletedValue is NSNull || ((deletedValue as? String)?.isEmpty == false) else { return nil }
    return RemoteRecord(
        entityType: entityType,
        entityId: entityId,
        version: version,
        serverVersion: serverVersion,
        deviceId: deviceValue as? String,
        payload: AnyCodable(object["payload"]),
        updatedAt: updatedValue as? String,
        deletedAt: deletedValue as? String
    )
}

private func optionalStrictWireBoolean(_ object: [String: Any], key: String) throws -> Bool? {
    guard object.keys.contains(key), let value = object[key], !(value is NSNull) else { return nil }
    guard let parsed = strictJSONBoolean(value) else {
        throw SyncError.validation("Sync push result contains an invalid \(key) flag. Pending mutations were not changed.")
    }
    return parsed
}

private func optionalStrictWireString(_ object: [String: Any], key: String) throws -> String? {
    guard object.keys.contains(key), let value = object[key], !(value is NSNull) else { return nil }
    guard let parsed = value as? String, !parsed.isEmpty else {
        throw SyncError.validation("Sync push result contains an invalid \(key). Pending mutations were not changed.")
    }
    return parsed
}

private func validSyncInstant(_ value: String) -> Bool {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: value) != nil || ISO8601DateFormatter().date(from: value) != nil
}

private actor SyncGate {
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func acquire() async {
        if !busy { busy = true; return }
        await withCheckedContinuation { c in waiters.append(c) }
    }
    func release() {
        if !waiters.isEmpty { let w = waiters.removeFirst(); w.resume() } else { busy = false }
    }
}

final class SyncEngine: @unchecked Sendable {
    static let shared = SyncEngine()
    private let metaStore: SyncMetaStore
    private let deviceIdStore: DeviceIdStore
    private let transport: any SyncTransport
    private let storeBridge: any SyncStoreBridge
    private let gate = SyncGate()
    private let retrySleeper: @Sendable (UInt64) async throws -> Void
    private let retryJitter: @Sendable (UInt64) -> UInt64

    init(
        metaStore: SyncMetaStore = SyncMetaStore(),
        deviceIdStore: DeviceIdStore = DeviceIdStore(),
        transport: any SyncTransport = URLSessionSyncTransport(),
        storeBridge: any SyncStoreBridge = FileSyncStoreBridge(),
        retrySleeper: @escaping @Sendable (UInt64) async throws -> Void = { try await Task<Never, Never>.sleep(nanoseconds: $0) },
        retryJitter: @escaping @Sendable (UInt64) -> UInt64 = { maximum in
            maximum == 0 ? 0 : UInt64.random(in: 0...maximum)
        }
    ) {
        self.metaStore = metaStore
        self.deviceIdStore = deviceIdStore
        self.transport = transport
        self.storeBridge = storeBridge
        self.retrySleeper = retrySleeper
        self.retryJitter = retryJitter
    }

    func synchronize() async throws {
        await gate.acquire()
        do {
            try await synchronizeOnce()
            await gate.release()
        } catch {
            await gate.release()
            throw error
        }
    }

    func bindingState(for userId: String) throws -> WorkspaceBindingState {
        try metaStore.bindingState(for: userId)
    }

    func bindLocalWorkspace(to userId: String) async throws {
        let transportUserId = (try await transport.currentUserId()).lowercased()
        guard transportUserId == userId.lowercased() else { throw SyncError.accountMismatch }
        try metaStore.bind(to: userId)
    }

    /// Reads the shared focus projection from the tracking singleton. A
    /// malformed nested record is treated as damaged local state so the
    /// execution UI cannot silently revive a different timer anchor.
    func loadTrackingFocusSession() throws -> SharedFocusSessionRecord? {
        let values = try storeBridge.loadValues()
        guard let tracking = values["tracking"] as? [String: Any],
              let raw = tracking["focusSession"] else { return nil }
        if raw is NSNull { return nil }
        guard let object = raw as? [String: Any],
              let session = SharedFocusSessionRecord(dictionary: object) else {
            throw SyncError.corruptStorage("The shared focus session is damaged. Nothing was replaced.")
        }
        return session
    }

    /// Stages one action-level focus record as a normal tracking mutation.
    /// The display ticker never calls this method; acquiring the sync gate
    /// keeps an action from racing a pull or another local action.
    func stageTrackingFocusSession(_ session: SharedFocusSessionRecord) async throws {
        await gate.acquire()
        do {
            var meta = try metaStore.load()
            var values = try storeBridge.loadValues()
            let previous = values["tracking"]
            var tracking: [String: Any]
            if let previous {
                guard let object = previous as? [String: Any] else {
                    throw SyncError.corruptStorage("The daily tracking projection is damaged. Nothing was replaced.")
                }
                tracking = object
                if let raw = tracking["focusSession"], !(raw is NSNull) {
                    guard let record = raw as? [String: Any], SharedFocusSessionRecord(dictionary: record) != nil else {
                        throw SyncError.corruptStorage("The shared focus session is damaged. Nothing was replaced.")
                    }
                }
            } else {
                tracking = [
                    "date": Self.todayString(),
                    "planViewCount": 0,
                    "dailyPostponeCount": 0
                ]
            }
            tracking["focusSession"] = session.toDictionary()
            values["tracking"] = tracking
            let now = ISO8601DateFormatter().string(from: Date())
            guard let transaction = try buildStagedLocalTransaction(
                storeName: "tracking",
                userKey: meta.accountUserId ?? "unbound-local-workspace",
                previousValue: previous,
                nextValue: tracking,
                order: Int(Date().timeIntervalSince1970 * 1000),
                now: now,
                randomUuid: { UUID().uuidString.lowercased() }
            ) else {
                await gate.release()
                return
            }
            meta = try appendStagedTransactions(meta, transactions: [transaction], deviceId: deviceIdStore.deviceId)
            let writes = try storeBridge.preparedWrites(values, stores: ["tracking"])
            try metaStore.commitLocalValues(writes, nextMeta: meta)
            NotificationCenter.default.post(name: .syncMutationCommitted, object: nil)
            await gate.release()
        } catch {
            await gate.release()
            throw error
        }
    }

    func resolveConflict(id: String, useLocal: Bool) async throws {
        await gate.acquire()
        do {
            try await resolveConflictWhileLocked(id: id, useLocal: useLocal)
            await gate.release()
        } catch {
            await gate.release()
            throw error
        }
    }

    private func resolveConflictWhileLocked(id: String, useLocal: Bool) async throws {
        var meta = try metaStore.load()
        guard let conflictIndex = meta.conflicts.firstIndex(where: { $0.id == id }) else {
            throw SyncError.validation("The selected synchronization conflict no longer exists.")
        }
        let conflict = meta.conflicts[conflictIndex]
        let key = syncEntityKey(conflict.entityType, conflict.entityId)

        if useLocal {
            if conflict.status == "resolving-local" { return }
            let current = meta.versions[key] ?? VersionPair(local: 0, server: conflict.serverVersion)
            let historyVersions = try conflict.localHistory.map { entry -> Int in
                guard let value = entry.value as? [String: Any],
                      let mutationId = value["mutationId"] as? String, UUID(uuidString: mutationId) != nil,
                      let version = strictJSONInteger(value["version"]), version > 0,
                      value.keys.contains("payload") else {
                    throw SyncError.validation("The conflict history is damaged. Both versions remain preserved.")
                }
                return version
            }
            let historyMax = historyVersions.max() ?? current.local
            let version = max(historyMax, current.local) + 1
            meta.versions[key] = VersionPair(local: version, server: conflict.serverVersion)
            let representedIds = Set(meta.outbox.map(\.mutationId)).union(meta.conflicts.flatMap { item in
                item.localHistory.compactMap { ($0.value as? [String: Any])?["mutationId"] as? String }
            })
            var resolutionMutationId = UUID().uuidString.lowercased()
            while representedIds.contains(resolutionMutationId) {
                resolutionMutationId = UUID().uuidString.lowercased()
            }
            meta.outbox.append(SyncMutation(
                mutationId: resolutionMutationId,
                deviceId: deviceIdStore.deviceId,
                entityType: conflict.entityType,
                entityId: conflict.entityId,
                baseServerVersion: conflict.serverVersion,
                version: version,
                payload: conflict.localPayload,
                updatedAt: ISO8601DateFormatter().string(from: Date()),
                deletedAt: conflict.localDeletedAt,
                dependsOnMutationId: nil,
                resolvesConflictId: conflict.id,
                attemptedAt: nil
            ))
            meta.conflicts[conflictIndex].status = "resolving-local"
            try metaStore.save(meta)
            return
        }

        // A PostgreSQL-ledger conflict must be acknowledged there before its
        // local copy is removed. Synthetic pull conflicts have no server row.
        if UUID(uuidString: conflict.id) != nil {
            guard UUID(uuidString: conflict.mutationId) != nil,
                  let boundUserId = meta.accountUserId else {
                throw SyncError.validation("The server conflict identity is invalid. Both versions remain preserved.")
            }
            let transportUserId = (try await transport.currentUserId()).lowercased()
            guard transportUserId == boundUserId.lowercased() else { throw SyncError.accountMismatch }
            let body = try JSONSerialization.data(withJSONObject: [
                "conflictId": conflict.id,
                "mutationId": conflict.mutationId,
                "choice": "cloud"
            ], options: [])
            let (data, response) = try await requestWithRetry(
                path: "/api/v1/sync/conflicts/resolve",
                method: "POST",
                body: body
            )
            guard (200..<300).contains(response.statusCode) else {
                throw SyncError.validation("The server conflict could not be resolved (HTTP \(response.statusCode)). Both versions remain preserved.")
            }
            guard data.count <= 64 * 1024,
                  let acknowledgment = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  strictJSONBoolean(acknowledgment["resolved"]) == true,
                  acknowledgment["conflictId"] as? String == conflict.id,
                  acknowledgment["mutationId"] as? String == conflict.mutationId else {
                throw SyncError.validation("The server did not acknowledge the exact conflict. Both versions remain preserved.")
            }
        }

        // Local edits may happen outside the sync gate while a request is in
        // flight. Never apply an earlier choice over a newly edited local side.
        meta = try metaStore.load()
        guard let refreshedIndex = meta.conflicts.firstIndex(where: { $0.id == id }),
              meta.conflicts[refreshedIndex] == conflict else {
            throw SyncError.validation("The conflict changed while it was being resolved. Both versions remain preserved for a new choice.")
        }

        var values = try storeBridge.loadValues()
        let shouldDelete = conflict.serverMissing || conflict.serverDeletedAt?.isEmpty == false
        if RECORD_LEVEL_STORES.contains(conflict.entityType) {
            var records = values[conflict.entityType] as? [[String: Any]] ?? []
            if conflict.entityId == "singleton", !conflict.serverMissing,
               let snapshot = conflict.serverPayload.value as? [[String: Any]] {
                let ids = snapshot.compactMap { $0["id"] as? String }
                guard ids.count == snapshot.count, Set(ids).count == snapshot.count else {
                    throw SyncError.validation("The cloud snapshot contains invalid or duplicate identities. Both versions remain preserved.")
                }
                for snapshotRecord in snapshot {
                    guard let recordId = snapshotRecord["id"] as? String, !recordId.isEmpty else {
                        throw SyncError.validation("The cloud snapshot contains an invalid identity. Both versions remain preserved.")
                    }
                    var record = snapshotRecord
                    if conflict.entityType == "tasks", record["version"] == nil {
                        record["version"] = max(meta.versions[syncEntityKey("tasks", recordId)]?.local ?? 0, 1)
                    }
                    if let index = records.firstIndex(where: { ($0["id"] as? String) == recordId }) {
                        records[index] = record
                    } else {
                        records.append(record)
                    }
                }
            } else if shouldDelete {
                records.removeAll { ($0["id"] as? String) == conflict.entityId }
            } else {
                guard var record = conflict.serverPayload.value as? [String: Any] else {
                    throw SyncError.validation("The cloud conflict payload is invalid. Nothing was applied.")
                }
                if let payloadId = record["id"] as? String, payloadId != conflict.entityId {
                    throw SyncError.validation("The cloud conflict identity does not match the selected entity. Nothing was applied.")
                }
                record["id"] = conflict.entityId
                if conflict.entityType == "tasks", record["version"] == nil {
                    record["version"] = max(meta.versions[key]?.local ?? 0, 1)
                }
                if let index = records.firstIndex(where: { ($0["id"] as? String) == conflict.entityId }) {
                    records[index] = record
                } else {
                    records.append(record)
                }
            }
            values[conflict.entityType] = records
        } else if shouldDelete {
            values.removeValue(forKey: conflict.entityType)
        } else {
            values[conflict.entityType] = conflict.serverPayload.value ?? NSNull()
        }

        var version = meta.versions[key] ?? VersionPair(local: 0, server: nil)
        version.server = conflict.serverVersion
        meta.versions[key] = version
        let removedMutationIds = Set(meta.outbox.filter {
            $0.entityType == conflict.entityType && $0.entityId == conflict.entityId
        }.map(\.mutationId))
        meta.outbox.removeAll { removedMutationIds.contains($0.mutationId) }
        for index in meta.outbox.indices {
            if let predecessor = meta.outbox[index].dependsOnMutationId,
               removedMutationIds.contains(predecessor) {
                meta.outbox[index].dependsOnMutationId = nil
            }
        }
        meta.conflicts.remove(at: refreshedIndex)
        let writes = try storeBridge.preparedWrites(values, stores: [conflict.entityType])
        try metaStore.commitLocalValues(writes, nextMeta: meta)
    }

    private func synchronizeOnce() async throws {
        let accountUserId = (try await transport.currentUserId()).lowercased()
        switch try metaStore.bindingState(for: accountUserId) {
        case .unbound: throw SyncError.bindingRequired
        case .differentAccount: throw SyncError.accountMismatch
        case .bound: break
        }
        // Ensure staged WAL flushed? For now assume meta already contains staged mutations via TaskStore staging
        // Push loop
        while true {
            let meta = try metaStore.load()
            let (batch, body) = try boundedSyncPush(readyOutbox(meta, limit: 50), allowStaged: true)
            if batch.isEmpty { break }
            // Mark attempted
            let now = ISO8601DateFormatter().string(from: Date())
            let metaAttempted = markMutationsAttempted(meta, ids: batch.map(\.mutationId), now: now)
            try metaStore.save(metaAttempted)
            let upload = try ReconciliationUpload.prepare(body, historyCount: 0)
            for chunk in upload.chunks {
                let chunkBody = try JSONSerialization.data(withJSONObject: chunk, options: [.sortedKeys])
                let (staged, response) = try await requestWithRetry(path: "/api/v1/sync/conflicts/stage", method: "POST", body: chunkBody)
                guard (200..<300).contains(response.statusCode) else {
                    throw SyncError.validation("Upload will resume. Your original change remains saved.")
                }
                try ReconciliationUpload.verifyAck(chunk, staged)
            }
            let requestBody = try upload.manifest.map { try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]) } ?? body
            let (data, resp) = try await requestWithRetry(path: upload.manifest == nil ? "/api/v1/sync/push" : "/api/v1/sync/push-staged", method: "POST", body: requestBody)
            guard (200..<300).contains(resp.statusCode) else {
                throw SyncError.validation("Sync push failed HTTP \(resp.statusCode)")
            }
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let resultsArr = obj["results"] as? [[String: Any]] else {
                throw SyncError.validation("Sync push failed: invalid results")
            }
            if resultsArr.count != batch.count { throw SyncError.validation("Sync push response did not acknowledge exactly the submitted mutations. Pending mutations were not changed.") }
            // Parse results
            var results: [PushResult] = []
            for r in resultsArr {
                guard let mid = r["mutationId"] as? String, !mid.isEmpty,
                      let accepted = strictJSONBoolean(r["accepted"]),
                      let sv = strictJSONInteger(r["serverVersion"]), sv >= 0 else {
                    throw SyncError.validation("Sync push result invalid. Pending mutations were not changed.")
                }
                if accepted && sv == 0 { throw SyncError.validation("Sync push result invalid. Pending mutations were not changed.") }
                let rec = parsePushReceiptRecord(r["record"])
                let pr = PushResult(
                    mutationId: mid,
                    accepted: accepted,
                    serverVersion: sv,
                    replayMismatch: try optionalStrictWireBoolean(r, key: "replayMismatch"),
                    serverMissing: try optionalStrictWireBoolean(r, key: "serverMissing"),
                    conflictId: try optionalStrictWireString(r, key: "conflictId"),
                    record: rec
                )
                results.append(pr)
            }
            let newMeta = try applyPushResults(metaAttempted, batch: batch, results: results)
            try metaStore.save(newMeta)
        }
        // Pull loop
        var hasMore = true
        while hasMore {
            let meta = try metaStore.load()
            let cursorBefore = meta.cursor
            let (data, resp) = try await requestWithRetry(path: "/api/v1/sync/pull?cursor=\(cursorBefore)&limit=100", method: "GET", body: nil)
            guard (200..<300).contains(resp.statusCode) else { throw SyncError.validation("Sync pull failed HTTP \(resp.statusCode)") }
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let recordsArr = obj["records"] as? [[String: Any]],
                  let nextCursor = strictJSONInteger(obj["nextCursor"]), nextCursor >= 0,
                  let hasMoreVal = strictJSONBoolean(obj["hasMore"]) else {
                throw SyncError.validation("Sync pull invalid cursor envelope")
            }
            if nextCursor < cursorBefore || (hasMoreVal && nextCursor == cursorBefore) {
                throw SyncError.validation("Remote synchronization cursor did not make safe progress. The cursor was not advanced.")
            }
            var records: [RemoteRecord] = []
            for r in recordsArr {
                guard let et = r["entityType"] as? String, !et.isEmpty,
                      let eid = r["entityId"] as? String, !eid.isEmpty,
                      let ver = strictJSONInteger(r["version"]), ver > 0,
                      let sv = strictJSONInteger(r["serverVersion"]), sv > 0,
                      r.keys.contains("deviceId"),
                      let deviceId = r["deviceId"] as? String, !deviceId.isEmpty,
                      let updatedAt = r["updatedAt"] as? String, validSyncInstant(updatedAt),
                      r.keys.contains("deletedAt"),
                      let payload = r["payload"] else {
                    throw SyncError.validation("Remote synchronization page contains invalid, stale, or duplicate information. The cursor was not advanced.")
                }
                let deletedValue = r["deletedAt"]
                guard deletedValue is NSNull
                        || ((deletedValue as? String).map(validSyncInstant) == true) else {
                    throw SyncError.validation("Remote synchronization page contains an invalid tombstone timestamp. The cursor was not advanced.")
                }
                records.append(RemoteRecord(
                    entityType: et,
                    entityId: eid,
                    version: ver,
                    serverVersion: sv,
                    deviceId: deviceId,
                    payload: AnyCodable(payload),
                    updatedAt: updatedAt,
                    deletedAt: deletedValue as? String
                ))
            }
            let highest = records.map(\.serverVersion).max() ?? cursorBefore
            if nextCursor != highest {
                throw SyncError.validation("Remote synchronization cursor would skip or discard information. The cursor was not advanced.")
            }
            let currentValues = try storeBridge.loadValues()
            let ownDeviceId = deviceIdStore.deviceId
            let now = ISO8601DateFormatter().string(from: Date())
            let res = try applyRemotePage(meta, currentValues: currentValues, records: records, nextCursor: nextCursor, ownDeviceId: ownDeviceId, now: now)
            let writes = try storeBridge.preparedWrites(res.values, stores: Set(res.changedStores))
            if writes.isEmpty {
                try metaStore.save(res.meta)
            } else {
                try metaStore.commitLocalValues(writes, nextMeta: res.meta)
            }
            hasMore = hasMoreVal
        }
        var conflictAfter: String? = nil
        repeat {
            let (conflictData, conflictResponse) = try await requestWithRetry(
                path: "/api/v1/sync/conflicts/page" + (conflictAfter.map { "?after=\($0)" } ?? ""),
                method: "GET",
                body: nil
            )
            guard (200..<300).contains(conflictResponse.statusCode) else {
                throw SyncError.validation("Server conflicts could not be verified (HTTP \(conflictResponse.statusCode)). Existing local state was not changed.")
            }
            guard let conflictBody = try JSONSerialization.jsonObject(with: conflictData) as? [String: Any],
                  conflictBody.keys.contains("conflicts") else {
                throw SyncError.validation("Sync conflict response was invalid. Existing local state was not changed.")
            }
            let remoteConflicts = try parseServerConflictSet(conflictBody["conflicts"])
            var previousConflictId = conflictAfter ?? ""
            guard remoteConflicts.count <= 20 else { throw SyncError.validation("Sync conflict page exceeds its limit.") }
            for conflict in remoteConflicts {
                guard conflict.id == conflict.id.lowercased(), conflict.id > previousConflictId else {
                    throw SyncError.validation("Sync conflict page did not advance safely.")
                }
                previousConflictId = conflict.id
            }
            guard let moreNumber = conflictBody["hasMore"] as? NSNumber,
                  CFGetTypeID(moreNumber) == CFBooleanGetTypeID() else {
                throw SyncError.validation("Sync conflict page has no continuation flag.")
            }
            let moreConflicts = moreNumber.boolValue
            if remoteConflicts.isEmpty {
                guard !moreConflicts, conflictBody["nextAfter"] is NSNull else {
                    throw SyncError.validation("Sync conflict page has an invalid terminal cursor.")
                }
            } else {
                guard moreConflicts, conflictBody["nextAfter"] as? String == previousConflictId else {
                    throw SyncError.validation("Sync conflict page has an invalid continuation cursor.")
                }
            }
            let mergedMeta = try mergeServerConflicts(try metaStore.load(), conflicts: remoteConflicts)
            try metaStore.save(mergedMeta)
            conflictAfter = remoteConflicts.isEmpty ? nil : previousConflictId
        } while conflictAfter != nil
        for conflict in try metaStore.load().conflicts where conflict.status == "unresolved" {
            let candidate = try automaticReconciliationCandidate(conflict)
            let body = try JSONSerialization.data(withJSONObject: candidate, options: [.sortedKeys])
            let upload = try ReconciliationUpload.prepare(body, historyCount: conflict.localHistory.count)
            for chunk in upload.chunks {
                let chunkBody = try JSONSerialization.data(withJSONObject: chunk, options: [.sortedKeys])
                let (staged, response) = try await requestWithRetry(path: "/api/v1/sync/conflicts/stage", method: "POST", body: chunkBody)
                guard (200..<300).contains(response.statusCode) else {
                    throw SyncError.validation("Reconciliation upload will resume. Your full history remains saved.")
                }
                try ReconciliationUpload.verifyAck(chunk, staged)
            }
            let requestBody = try upload.manifest.map { try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]) } ?? body
            let (data, response) = try await requestWithRetry(path: upload.manifest == nil ? "/api/v1/sync/conflicts/reconcile" : "/api/v1/sync/conflicts/reconcile-staged", method: "POST", body: requestBody)
            guard (200..<300).contains(response.statusCode), data.count <= 16 * 1024 * 1024,
                  let reply = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw SyncError.validation("Automatic sync will retry. Your saved changes remain available.")
            }
            let current = try metaStore.load()
            guard current.accountUserId?.lowercased() == accountUserId else { throw SyncError.accountMismatch }
            let transition = try applyAutomaticReconciliation(current, currentValues: storeBridge.loadValues(), candidate: candidate, reply: reply)
            let writes = try storeBridge.preparedWrites(transition.values, stores: transition.changedStores)
            if writes.isEmpty { try metaStore.save(transition.meta) }
            else { try metaStore.commitLocalValues(writes, nextMeta: transition.meta) }
        }
        // Mark successful
        var finalMeta = try metaStore.load()
        finalMeta.lastSuccessfulSync = ISO8601DateFormatter().string(from: Date())
        try metaStore.save(finalMeta)
    }

    private func isValidUUID(_ s: String) -> Bool {
        UUID(uuidString: s) != nil
    }

    private func requestWithRetry(path: String, method: String, body: Data?) async throws -> (Data, HTTPURLResponse) {
        let maximumAttempts = 4
        var attempt = 1
        while true {
            do {
                let result = try await transport.request(path: path, method: method, headers: [:], body: body)
                if Self.isTransientStatus(result.1.statusCode), attempt < maximumAttempts {
                    try await waitBeforeRetry(afterAttempt: attempt)
                    attempt += 1
                    continue
                }
                return result
            } catch {
                guard Self.isTransientTransportError(error), attempt < maximumAttempts else { throw error }
                try await waitBeforeRetry(afterAttempt: attempt)
                attempt += 1
            }
        }
    }

    private func waitBeforeRetry(afterAttempt attempt: Int) async throws {
        let cap: UInt64 = 2_000_000_000
        let exponent = UInt64(max(0, min(attempt - 1, 3)))
        let base = min(cap, 250_000_000 << exponent)
        let jitterMaximum = base / 4
        let jitter = min(retryJitter(jitterMaximum), jitterMaximum)
        try await retrySleeper(min(cap, base + jitter))
    }

    private static func isTransientStatus(_ status: Int) -> Bool {
        status >= 500 || [408, 425, 429].contains(status)
    }

    private static func isTransientTransportError(_ error: Error) -> Bool {
        if let keychainError = error as? KeychainError, case .transient = keychainError { return true }
        guard let urlError = error as? URLError else { return false }
        return [
            .timedOut,
            .cannotFindHost,
            .cannotConnectToHost,
            .networkConnectionLost,
            .dnsLookupFailed,
            .notConnectedToInternet,
            .resourceUnavailable,
            .internationalRoamingOff,
            .callIsActive,
            .dataNotAllowed
        ].contains(urlError.code)
    }

    private static func todayString() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = .current
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter.string(from: Date())
    }
}


func automaticReconciliationCandidate(_ conflict: LocalConflict) throws -> [String: Any] {
    guard !conflict.localHistory.isEmpty else {
        throw SyncError.validation("The saved sync history is unavailable. Nothing was discarded.")
    }
    var identities = Set<String>()
    let history = try conflict.localHistory.map { entry -> [String: Any] in
        guard let item = entry.value as? [String: Any],
              let id = item["mutationId"] as? String, UUID(uuidString: id) != nil,
              identities.insert(id.lowercased()).inserted,
              let version = strictJSONInteger(item["version"]), version > 0,
              let updatedAt = item["updatedAt"] as? String, validSyncInstant(updatedAt),
              item.keys.contains("payload"), item.keys.contains("deletedAt"),
              item["deletedAt"] is NSNull || (item["deletedAt"] as? String).map(validSyncInstant) == true else {
            throw SyncError.validation("The saved sync history is invalid. Nothing was discarded.")
        }
        return item
    }
    return ["conflictId": conflict.id,
            "sourceMutationId": UUID(uuidString: conflict.mutationId) != nil ? conflict.mutationId as Any : NSNull(),
            "entityType": conflict.entityType, "entityId": conflict.entityId, "localHistory": history]
}

func applyAutomaticReconciliation(
    _ input: SyncMeta, currentValues: [String: Any], candidate: [String: Any], reply: [String: Any]
) throws -> (meta: SyncMeta, values: [String: Any], changedStores: Set<String>) {
    guard strictJSONBoolean(reply["reconciled"]) == true,
          let receiptId = reply["receiptId"] as? String, UUID(uuidString: receiptId) != nil,
          stableJson(reply["candidate"]) == stableJson(candidate),
          let missing = strictJSONBoolean(reply["serverMissing"]),
          let conflictId = candidate["conflictId"] as? String,
          let entityType = candidate["entityType"] as? String,
          let entityId = candidate["entityId"] as? String else {
        throw SyncError.validation("Automatic sync did not acknowledge the exact saved changes.")
    }
    let record = reply["record"] as? [String: Any]
    var serverVersion = 0
    var version = 0
    if !missing {
        guard let record,
              record["entity_type"] as? String == entityType, record["entity_id"] as? String == entityId,
              let device = record["device_id"] as? String, !device.isEmpty,
              let recordVersion = strictJSONInteger(record["version"]), recordVersion > 0,
              let revision = strictJSONInteger(record["server_version"]), revision > 0,
              let updatedAt = record["updated_at"] as? String, validSyncInstant(updatedAt),
              record.keys.contains("payload"), record.keys.contains("deleted_at"),
              record["deleted_at"] is NSNull || (record["deleted_at"] as? String).map(validSyncInstant) == true else {
            throw SyncError.validation("Automatic sync returned an invalid cloud record.")
        }
        serverVersion = revision; version = recordVersion
        if RECORD_LEVEL_STORES.contains(entityType), record["deleted_at"] is NSNull {
            guard let payload = record["payload"] as? [String: Any], payload["id"] as? String == entityId else {
                throw SyncError.validation("Automatic sync returned a different task identity.")
            }
        }
    } else if !(reply["record"] is NSNull) && reply["record"] != nil {
        throw SyncError.validation("Automatic sync returned an ambiguous cloud record.")
    }
    var meta = input
    var values = currentValues
    guard let index = meta.conflicts.firstIndex(where: { $0.id == conflictId }),
          stableJson(try automaticReconciliationCandidate(meta.conflicts[index])) == stableJson(candidate) else {
        return (meta, values, [])
    }
    let key = syncEntityKey(entityType, entityId)
    guard serverVersion >= (meta.versions[key]?.server ?? 0) else {
        throw SyncError.validation("Automatic sync returned an older cloud revision. Your changes remain saved.")
    }
    meta.conflicts.remove(at: index)
    meta.versions[key] = VersionPair(local: max(meta.versions[key]?.local ?? 0, version), server: serverVersion)
    // Preserve any edit made during the request; its original outbox identity
    // and visible value must survive the acknowledgment of an earlier history.
    if meta.outbox.contains(where: { $0.entityType == entityType && $0.entityId == entityId })
        || meta.conflicts.contains(where: { $0.entityType == entityType && $0.entityId == entityId }) {
        return (meta, values, [])
    }
    let deleted = missing || record?["deleted_at"] is String
    if RECORD_LEVEL_STORES.contains(entityType) {
        guard values[entityType] == nil || values[entityType] is [[String: Any]] else {
            throw SyncError.validation("Saved records could not be loaded safely. Nothing was discarded.")
        }
        var records = values[entityType] as? [[String: Any]] ?? []
        records.removeAll { $0["id"] as? String == entityId }
        if !deleted, let payload = record?["payload"] as? [String: Any] { records.append(payload) }
        values[entityType] = records
    } else if deleted {
        values.removeValue(forKey: entityType)
    } else {
        values[entityType] = record?["payload"]
    }
    return (meta, values, [entityType])
}

/// The limit counts UTF-8 JSON body bytes, not HTTP headers. Return the exact
/// serialized body that was measured; never rewrite an attempted mutation.
func boundedSyncPush(_ ready: [SyncMutation], allowStaged: Bool = false) throws -> (batch: [SyncMutation], body: Data) {
    var batch: [SyncMutation] = []
    var body = try JSONSerialization.data(withJSONObject: ["mutations": []], options: [])
    for mutation in ready.prefix(50) {
        let candidate = batch + [mutation]
        let wire = candidate.map { m -> [String: Any] in
            var d: [String: Any] = [
                "mutationId": m.mutationId,
                "deviceId": m.deviceId,
                "entityType": m.entityType,
                "entityId": m.entityId,
                "version": m.version,
                "payload": m.payload.value ?? NSNull(),
                "updatedAt": m.updatedAt
            ]
            if let b = m.baseServerVersion { d["baseServerVersion"] = b } else { d["baseServerVersion"] = NSNull() }
            if let dep = m.dependsOnMutationId { d["dependsOnMutationId"] = dep }
            if let del = m.deletedAt { d["deletedAt"] = del } else { d["deletedAt"] = NSNull() }
            if let rid = m.resolvesConflictId, UUID(uuidString: rid) != nil { d["resolvesConflictId"] = rid }
            return d
        }

        let candidateBody = try JSONSerialization.data(withJSONObject: ["mutations": wire], options: [])
        if candidateBody.count > 256 * 1024 {
            if batch.isEmpty && allowStaged && candidateBody.count <= 4 * 1024 * 1024 {
                return (candidate, candidateBody)
            }
            if batch.isEmpty {
                throw SyncError.validation("A preserved change exceeds the sync request limit. It remains saved locally; retry after large-record recovery is available.")
            }
            break
        }
        batch = candidate
        body = candidateBody
    }
    return (batch, body)
}
