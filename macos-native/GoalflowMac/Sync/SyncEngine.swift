import Foundation

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
            let batch = readyOutbox(meta, limit: 50)
            if batch.isEmpty { break }
            let wire = batch.map { m -> [String: Any] in
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
                if let rid = m.resolvesConflictId, isValidUUID(rid) { d["resolvesConflictId"] = rid }
                return d
            }
            // Mark attempted
            let now = ISO8601DateFormatter().string(from: Date())
            let metaAttempted = markMutationsAttempted(meta, ids: batch.map(\.mutationId), now: now)
            try metaStore.save(metaAttempted)
            let body = try JSONSerialization.data(withJSONObject: ["mutations": wire], options: [])
            let (data, resp) = try await requestWithRetry(path: "/api/v1/sync/push", method: "POST", body: body)
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
        let (conflictData, conflictResponse) = try await requestWithRetry(
            path: "/api/v1/sync/conflicts",
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
        let mergedMeta = try mergeServerConflicts(try metaStore.load(), conflicts: remoteConflicts)
        try metaStore.save(mergedMeta)
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
}
