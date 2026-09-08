import Foundation

private func isRecord(_ v: Any?) -> Bool { v is [String: Any] }

// Record map: array of records with id:String -> Map
private func recordMap(_ value: Any?) -> [String: [String: Any]]? {
    guard let arr = value as? [[String: Any]] else {
        if value == nil { return [:] } // null/undefined -> empty map
        if value is NSNull { return [:] }
        return nil
    }
    var result: [String: [String: Any]] = [:]
    for item in arr {
        guard let id = item["id"] as? String, !id.isEmpty else { return nil }
        if result[id] != nil { return nil } // duplicate signal via nil then throw outside? We'll throw in caller
        result[id] = item
    }
    return result
}

func buildStagedLocalTransaction(storeName: String, userKey: String, previousValue: Any?, nextValue: Any?, order: Int, now: String, randomUuid: () -> String) throws -> StagedLocalTransaction? {
    // stableJson equal check
    if stableJson(previousValue) == stableJson(nextValue) { return nil }
    var changes: [StagedEntityChange] = []
    let isRecordLevel = RECORD_LEVEL_STORES.contains(storeName)
    if isRecordLevel {
        guard let prevMap = recordMap(previousValue), let nextMap = recordMap(nextValue) else {
            // Check duplicate detection: if recordMap returns nil due to missing id or not array, throw
            // Try to detect duplicate
            if let arr = previousValue as? [[String: Any]] {
                let ids = arr.compactMap { $0["id"] as? String }
                if ids.count != Set(ids).count { throw SyncError.validation("Record identity \(ids) appears more than once. The local change was not applied.") }
            }
            if let arr = nextValue as? [[String: Any]] {
                let ids = arr.compactMap { $0["id"] as? String }
                if ids.count != Set(ids).count { throw SyncError.validation("Record identity \(ids) appears more than once. The local change was not applied.") }
            }
            throw SyncError.validation("Record-level store \(storeName) contains data without stable identities. The change was not staged.")
        }
        // Detect duplicate in prevMap/nextMap already done
        let ids = Set(prevMap.keys).union(nextMap.keys).sorted()
        for id in ids {
            let before = prevMap[id]
            let after = nextMap[id]
            if stableJson(before) == stableJson(after) { continue }
            let deletedAt: String?
            if let a = after, let d = a["deletedAt"] as? String, !d.isEmpty { deletedAt = d }
            else if after == nil { deletedAt = now }
            else { deletedAt = nil }
            let payload: Any? = after ?? before
            changes.append(StagedEntityChange(
                mutationId: randomUuid(),
                entityType: storeName,
                entityId: id,
                payload: payload,
                updatedAt: now,
                deletedAt: deletedAt
            ))
        }
    } else {
        let payload: Any? = nextValue
        let deleted: String? = (nextValue == nil) ? now : nil
        changes.append(StagedEntityChange(
            mutationId: randomUuid(),
            entityType: storeName,
            entityId: "singleton",
            payload: payload,
            updatedAt: now,
            deletedAt: deleted
        ))
    }
    return StagedLocalTransaction(
        id: randomUuid(),
        userKey: userKey,
        storeName: storeName,
        storageKey: userKey,
        previousValue: previousValue,
        hasPreviousValue: true,
        value: nextValue,
        changes: changes,
        order: order,
        createdAt: now
    )
}

func cloneMeta(_ meta: SyncMeta) -> SyncMeta { meta } // struct copy

func appendStagedTransactions(_ input: SyncMeta, transactions: [StagedLocalTransaction], deviceId: String) throws -> SyncMeta {
    var meta = cloneMeta(input)
    // Sort transactions by order then id
    let sorted = transactions.sorted { a, b in
        if a.order != b.order { return a.order < b.order }
        return a.id < b.id
    }
    for tx in sorted {
        for change in tx.changes {
            let key = syncEntityKey(change.entityType, change.entityId)
            // Find conflict
            if let cIdx = meta.conflicts.firstIndex(where: { $0.entityType == change.entityType && $0.entityId == change.entityId && $0.status == "unresolved" }) {
                // Append to conflict history, not outbox
                var conflict = meta.conflicts[cIdx]
                // Find current local version
                let currentLocal = meta.versions[key]?.local ?? 0
                let latestForEntity = meta.outbox.filter { $0.entityType == change.entityType && $0.entityId == change.entityId }.max(by: { $0.version < $1.version })
                let version = max(currentLocal, latestForEntity?.version ?? 0) + 1
                // Update versions
                var v = meta.versions[key] ?? VersionPair(local: 0, server: nil)
                v.local = version
                meta.versions[key] = v
                // Append to history
                var history = conflict.localHistory
                // Each history entry as AnyCodable with payload etc
                let entry: [String: Any] = [
                    "mutationId": change.mutationId,
                    "payload": change.payload ?? NSNull(),
                    "deletedAt": change.deletedAt.map { $0 as Any } ?? NSNull(),
                    "updatedAt": change.updatedAt,
                    "version": version
                ]
                history.append(AnyCodable(entry))
                conflict.localPayload = AnyCodable(change.payload)
                conflict.localDeletedAt = change.deletedAt
                conflict.localHistory = history
                meta.conflicts[cIdx] = conflict
                continue
            }
            let currentLocal = meta.versions[key]?.local ?? 0
            let latestForEntity = meta.outbox.filter { $0.entityType == change.entityType && $0.entityId == change.entityId }.max(by: { $0.version < $1.version })
            let version = max(currentLocal, latestForEntity?.version ?? 0) + 1
            // Update versions
            var v = meta.versions[key] ?? VersionPair(local: 0, server: nil)
            v.local = version
            meta.versions[key] = v
            let mutation = SyncMutation(
                mutationId: change.mutationId,
                deviceId: deviceId,
                entityType: change.entityType,
                entityId: change.entityId,
                baseServerVersion: latestForEntity != nil ? nil : v.server,
                version: version,
                payload: AnyCodable(change.payload),
                updatedAt: change.updatedAt,
                deletedAt: change.deletedAt,
                dependsOnMutationId: latestForEntity?.mutationId,
                resolvesConflictId: nil,
                attemptedAt: nil
            )
            meta.outbox.append(mutation)
        }
    }
    return meta
}

func readyOutbox(_ meta: SyncMeta, limit: Int = 50) -> [SyncMutation] {
    let pendingIds = Set(meta.outbox.map(\.mutationId))
    var selectedEntities = Set<String>()
    var ready: [SyncMutation] = []
    let sorted = meta.outbox.sorted { a, b in
        if a.version != b.version { return a.version < b.version }
        return a.mutationId < b.mutationId
    }
    for m in sorted {
        if let dep = m.dependsOnMutationId, pendingIds.contains(dep) { continue }
        let key = syncEntityKey(m.entityType, m.entityId)
        if selectedEntities.contains(key) { continue }
        selectedEntities.insert(key)
        ready.append(m)
        if ready.count >= limit { break }
    }
    return ready
}

func markMutationsAttempted(_ meta: SyncMeta, ids: [String], now: String) -> SyncMeta {
    var m = meta
    for i in m.outbox.indices where ids.contains(m.outbox[i].mutationId) {
        m.outbox[i].attemptedAt = now
    }
    return m
}
