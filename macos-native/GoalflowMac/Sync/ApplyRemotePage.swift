import Foundation

func applyRemotePage(_ input: SyncMeta, currentValues: [String: Any], records: [RemoteRecord], nextCursor: Int, ownDeviceId: String, now: String) throws -> (meta: SyncMeta, values: [String: Any], changedStores: [String]) {
    var meta = cloneMeta(input)
    guard nextCursor >= meta.cursor else {
        throw SyncError.validation("Remote synchronization cursor is invalid or moved backwards. The cursor was not advanced.")
    }
    // Validate records
    var seenServerVersions = Set<Int>()
    for rec in records {
        guard !rec.entityType.isEmpty, !rec.entityId.isEmpty, rec.version >= 0, rec.serverVersion > meta.cursor else {
            throw SyncError.validation("Remote synchronization page contains invalid, stale, or duplicate information. The cursor was not advanced.")
        }
        if seenServerVersions.contains(rec.serverVersion) {
            throw SyncError.validation("Remote synchronization page contains duplicate serverVersion. The cursor was not advanced.")
        }
        seenServerVersions.insert(rec.serverVersion)
        guard supportedStores.contains(rec.entityType) else {
            throw SyncError.validation("Remote synchronization page contains invalid, stale, or duplicate information. The cursor was not advanced.")
        }
    }
    let highest = records.map(\.serverVersion).max() ?? meta.cursor
    guard nextCursor == highest else {
        throw SyncError.validation("Remote synchronization cursor would skip or discard information. The cursor was not advanced.")
    }
    // Sort by serverVersion
    let sorted = records.sorted { $0.serverVersion < $1.serverVersion }
    var values = currentValues
    var changedStores = Set<String>()
    for rec in sorted {
        let key = syncEntityKey(rec.entityType, rec.entityId)
        let hasPending = meta.outbox.contains { $0.entityType == rec.entityType && $0.entityId == rec.entityId }
        if hasPending {
            // Create pull conflict
            let pending = meta.outbox.filter { $0.entityType == rec.entityType && $0.entityId == rec.entityId }
            guard let latest = pending.max(by: { $0.version < $1.version }) else { continue }
            let history = pending.sorted { $0.version < $1.version }.map { m -> AnyCodable in
                let d: [String: Any] = [
                    "mutationId": m.mutationId,
                    "payload": m.payload.value ?? NSNull(),
                    "deletedAt": m.deletedAt.map { $0 as Any } ?? NSNull(),
                    "updatedAt": m.updatedAt,
                    "version": m.version
                ]
                return AnyCodable(d)
            }
            let cid = "pull:\(rec.entityType):\(rec.entityId):\(rec.serverVersion)"
            if !meta.conflicts.contains(where: { $0.id == cid }) {
                let conflict = LocalConflict(
                    id: cid,
                    entityType: rec.entityType,
                    entityId: rec.entityId,
                    mutationId: latest.mutationId,
                    baseServerVersion: latest.baseServerVersion,
                    serverVersion: rec.serverVersion,
                    localPayload: latest.payload,
                    localDeletedAt: latest.deletedAt,
                    localHistory: history,
                    serverPayload: rec.payload,
                    serverMissing: false,
                    serverDeletedAt: rec.deletedAt,
                    status: "unresolved",
                    createdAt: now
                )
                meta.conflicts.append(conflict)
            }
            // Remove pending chain
            let toRemove = Set(pending.map(\.mutationId))
            meta.outbox.removeAll { toRemove.contains($0.mutationId) }
            // Update versions local stays, server updates
            var v = meta.versions[key] ?? VersionPair(local: latest.version, server: nil)
            v.local = max(v.local, latest.version)
            meta.versions[key] = v
            // Release dependents
            for i in meta.outbox.indices where meta.outbox[i].dependsOnMutationId != nil && meta.outbox[i].dependsOnMutationId.map({ toRemove.contains($0) }) == true {
                meta.outbox[i].dependsOnMutationId = nil
            }
            continue
        }
        // Check if conflict exists and retain newest
        if let cIdx = meta.conflicts.firstIndex(where: { $0.entityType == rec.entityType && $0.entityId == rec.entityId }) {
            var c = meta.conflicts[cIdx]
            if rec.serverVersion > c.serverVersion {
                c.serverPayload = rec.payload
                c.serverDeletedAt = rec.deletedAt
                c.serverVersion = rec.serverVersion
                meta.conflicts[cIdx] = c
            }
            continue
        }
        // Apply if serverVersion > versions[key].server
        let currentServer = meta.versions[key]?.server ?? 0
        if rec.serverVersion > currentServer {
            // Upsert
            if RECORD_LEVEL_STORES.contains(rec.entityType) {
                var currentArr = values[rec.entityType] as? [[String: Any]] ?? []
                if rec.entityId == "singleton", let snapshot = rec.payload.value as? [[String: Any]] {
                    let ids = snapshot.compactMap { $0["id"] as? String }
                    guard ids.count == snapshot.count, Set(ids).count == snapshot.count else {
                        throw SyncError.validation("A legacy remote snapshot contains invalid or duplicate identities. The cursor was not advanced.")
                    }
                    if rec.deletedAt?.isEmpty == false {
                        currentArr = []
                    } else {
                        for var record in snapshot {
                            guard let recordId = record["id"] as? String, !recordId.isEmpty else {
                                throw SyncError.validation("A legacy remote snapshot contains an invalid identity. The cursor was not advanced.")
                            }
                            if rec.entityType == "tasks" {
                                if record["version"] == nil { record["version"] = rec.version }
                                if record["updatedAt"] == nil, let updatedAt = rec.updatedAt { record["updatedAt"] = updatedAt }
                            }
                            if let index = currentArr.firstIndex(where: { ($0["id"] as? String) == recordId }) {
                                currentArr[index] = record
                            } else {
                                currentArr.append(record)
                            }
                        }
                    }
                } else if let del = rec.deletedAt, !del.isEmpty {
                    currentArr.removeAll { ($0["id"] as? String) == rec.entityId }
                } else {
                    guard var payloadDict = rec.payload.value as? [String: Any] else {
                        throw SyncError.validation("A remote record payload is invalid. The cursor was not advanced.")
                    }
                    payloadDict["id"] = rec.entityId
                    if rec.entityType == "tasks" {
                        if payloadDict["version"] == nil { payloadDict["version"] = rec.version }
                        if payloadDict["updatedAt"] == nil, let updatedAt = rec.updatedAt { payloadDict["updatedAt"] = updatedAt }
                    }
                    if let idx = currentArr.firstIndex(where: { ($0["id"] as? String) == rec.entityId }) {
                        currentArr[idx] = payloadDict
                    } else {
                        currentArr.append(payloadDict)
                    }
                }
                values[rec.entityType] = currentArr
            } else {
                // Singleton
                if let del = rec.deletedAt, !del.isEmpty {
                    values.removeValue(forKey: rec.entityType)
                } else {
                    values[rec.entityType] = rec.payload.value
                }
            }
            var v = meta.versions[key] ?? VersionPair(local: 0, server: nil)
            v.local = max(v.local, rec.version)
            v.server = rec.serverVersion
            meta.versions[key] = v
            changedStores.insert(rec.entityType)
        }
    }
    meta.cursor = nextCursor
    return (meta, values, Array(changedStores))
}

let supportedStores: Set<String> = ["tasks","goals","habits","stats","progress","hashtags","accountability","truenorth","amalgam","tracking","circadian","settings","daily_plans","task_events"]
