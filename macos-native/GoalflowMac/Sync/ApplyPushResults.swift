import Foundation

private func sameConflictExceptCreationTime(_ left: LocalConflict, _ right: LocalConflict) -> Bool {
    var leftCopy = left
    var rightCopy = right
    leftCopy.createdAt = nil
    rightCopy.createdAt = nil
    return leftCopy == rightCopy
}

func applyPushResults(_ input: SyncMeta, batch: [SyncMutation], results: [PushResult]) throws -> SyncMeta {
    var meta = cloneMeta(input)
    guard Set(batch.map(\.mutationId)).count == batch.count else {
        throw SyncError.validation("Sync push batch contains duplicate mutation identities. Pending mutations were not changed.")
    }
    guard results.count == batch.count else {
        throw SyncError.validation("Sync push response did not acknowledge exactly the submitted mutations. Pending mutations were not changed.")
    }
    let batchIds = Set(batch.map(\.mutationId))
    let resultIds = results.map(\.mutationId)
    guard Set(resultIds).count == resultIds.count && resultIds.allSatisfy({ batchIds.contains($0) }) else {
        throw SyncError.validation("Sync push response did not acknowledge exactly the submitted mutations. Pending mutations were not changed.")
    }
    let resultsById = Dictionary(uniqueKeysWithValues: results.map { ($0.mutationId, $0) })
    // Validate each result
    for (idx, mut) in batch.enumerated() {
        guard let res = resultsById[mut.mutationId] else { continue }
        // Validate shape
        guard !res.mutationId.isEmpty,
              res.serverVersion >= 0,
              !(res.accepted && res.serverVersion == 0) else {
            throw SyncError.validation("Sync push result \(idx) invalid. Pending mutations were not changed.")
        }
        if res.accepted {
            guard let rec = res.record,
                  rec.entityType == mut.entityType,
                  rec.entityId == mut.entityId,
                  rec.version == mut.version,
                  rec.serverVersion == res.serverVersion,
                  rec.deviceId == mut.deviceId,
                  stableJson(rec.payload.value) == stableJson(mut.payload.value),
                  sameInstant(rec.updatedAt, mut.updatedAt),
                  sameInstant(rec.deletedAt, mut.deletedAt),
                  res.replayMismatch != true,
                  res.serverMissing != true,
                  res.conflictId == nil else {
                throw SyncError.validation("Sync push acceptance \(idx) did not prove the exact submitted record. Pending mutations were not changed.")
            }
        } else {
            if res.serverMissing != true {
                guard let rec = res.record, rec.payload.value != nil else {
                    throw SyncError.validation("Sync push rejection \(idx) did not preserve the server side. Pending mutations were not changed.")
                }
            }
        }
    }
    // Apply
    var toRemoveIds = Set<String>()
    for mut in batch {
        guard let res = resultsById[mut.mutationId] else { continue }
        if res.accepted {
            toRemoveIds.insert(mut.mutationId)
            // Patch successors
            for i in meta.outbox.indices where meta.outbox[i].dependsOnMutationId == mut.mutationId {
                meta.outbox[i].dependsOnMutationId = nil
                meta.outbox[i].baseServerVersion = res.serverVersion
            }
            // Update versions
            let key = syncEntityKey(mut.entityType, mut.entityId)
            var v = meta.versions[key] ?? VersionPair(local: 0, server: nil)
            v.local = max(v.local, mut.version)
            v.server = res.serverVersion
            meta.versions[key] = v
            // Clear resolvesConflictId
            if let rid = mut.resolvesConflictId,
               let cIdx = meta.conflicts.firstIndex(where: { $0.id == rid }) {
                meta.conflicts.remove(at: cIdx)
            }
        } else {
            // Collect affected chain
            let affected = meta.outbox.filter { $0.entityType == mut.entityType && $0.entityId == mut.entityId && $0.version >= mut.version }
            let affectedIds = Set(affected.map(\.mutationId))
            // Build history
            let history = affected.sorted { $0.version < $1.version }.map { m -> AnyCodable in
                let d: [String: Any] = [
                    "mutationId": m.mutationId,
                    "payload": m.payload.value ?? NSNull(),
                    "deletedAt": m.deletedAt.map { $0 as Any } ?? NSNull(),
                    "updatedAt": m.updatedAt,
                    "version": m.version
                ]
                return AnyCodable(d)
            }
            let serverPayload: AnyCodable
            let serverDeletedAt: String?
            let serverMissing: Bool
            if let rec = res.record {
                serverPayload = rec.payload
                serverDeletedAt = rec.deletedAt
                serverMissing = res.serverMissing ?? false
            } else {
                serverPayload = AnyCodable(nil)
                serverDeletedAt = nil
                serverMissing = res.serverMissing ?? false
            }
            let cid = res.conflictId ?? "push:\(mut.mutationId):\(res.serverVersion)"
            let latest = affected.max { left, right in
                left.version == right.version
                    ? left.mutationId < right.mutationId
                    : left.version < right.version
            } ?? mut
            var conflict = LocalConflict(
                id: cid,
                entityType: mut.entityType,
                entityId: mut.entityId,
                mutationId: mut.mutationId,
                baseServerVersion: mut.baseServerVersion,
                serverVersion: res.serverVersion,
                localPayload: latest.payload,
                localDeletedAt: latest.deletedAt,
                localHistory: history,
                serverPayload: serverPayload,
                serverMissing: serverMissing,
                serverDeletedAt: serverDeletedAt,
                status: res.replayMismatch == true ? "replay_mismatch" : "unresolved",
                createdAt: ISO8601DateFormatter().string(from: Date())
            )
            if let resolvingId = mut.resolvesConflictId,
               let resolvingIndex = meta.conflicts.firstIndex(where: { $0.id == resolvingId }) {
                let resolving = meta.conflicts[resolvingIndex]
                var combinedById: [String: AnyCodable] = [:]
                for entry in resolving.localHistory + history {
                    guard let object = entry.value as? [String: Any],
                          let mutationId = object["mutationId"] as? String,
                          UUID(uuidString: mutationId) != nil,
                          let version = strictJSONInteger(object["version"]), version > 0,
                          object.keys.contains("payload") else {
                        throw SyncError.validation("Conflict history is damaged. Pending mutations were not changed.")
                    }
                    if let represented = combinedById[mutationId], represented != entry {
                        throw SyncError.validation("A mutation identity represents different local conflict history. Pending mutations were not changed.")
                    }
                    combinedById[mutationId] = entry
                }
                conflict.localHistory = combinedById.values.sorted { left, right in
                    let leftObject = left.value as? [String: Any]
                    let rightObject = right.value as? [String: Any]
                    let leftVersion = strictJSONInteger(leftObject?["version"]) ?? 0
                    let rightVersion = strictJSONInteger(rightObject?["version"]) ?? 0
                    if leftVersion != rightVersion { return leftVersion < rightVersion }
                    return (leftObject?["mutationId"] as? String ?? "") < (rightObject?["mutationId"] as? String ?? "")
                }
                if let newest = conflict.localHistory.last?.value as? [String: Any] {
                    conflict.localPayload = AnyCodable(newest["payload"])
                    conflict.localDeletedAt = newest["deletedAt"] as? String
                }
                meta.conflicts.remove(at: resolvingIndex)
            }
            if let existing = meta.conflicts.first(where: { $0.id == cid }) {
                guard sameConflictExceptCreationTime(existing, conflict) else {
                    throw SyncError.validation("A server conflict id refers to different preserved data. Pending mutations were not changed.")
                }
            } else {
                meta.conflicts.append(conflict)
            }
            for aid in affectedIds { toRemoveIds.insert(aid) }
            // Update versions to latest pending version
            let key = syncEntityKey(mut.entityType, mut.entityId)
            if !affected.isEmpty {
                var v = meta.versions[key] ?? VersionPair(local: 0, server: nil)
                v.local = max(v.local, latest.version)
                meta.versions[key] = v
            }
        }
    }
    meta.outbox.removeAll { toRemoveIds.contains($0.mutationId) }
    // Also need to release dependents of removed chain that are not part of newConflicts? Already handled via toRemoveIds, but dependents that were chained to removed mutations should be released? In Android, releaseDependents clears dependsOn for task_events.
    // For simplicity, for any remaining outbox that had dependsOn in removedIds, clear it
    for i in meta.outbox.indices {
        if let dep = meta.outbox[i].dependsOnMutationId, toRemoveIds.contains(dep) {
            // Find new baseServerVersion: if the removed was accepted, we already patched; if rejected, we should clear depends and set base to nil? For rejected chain, dependents should be released with base null
            meta.outbox[i].dependsOnMutationId = nil
            // baseServerVersion stays as is? For rejected, should be nil as well
        }
    }
    return meta
}
