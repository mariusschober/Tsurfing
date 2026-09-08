import Foundation

struct RemoteServerConflict: Equatable, Sendable {
    var id: String
    var entityType: String
    var entityId: String
    var mutationId: String
    var baseServerVersion: Int?
    var localPayload: AnyCodable
    var localDeletedAt: String?
    var localVersion: Int
    var localUpdatedAt: String
    var serverPayload: AnyCodable
    var serverDeletedAt: String?
    var serverVersion: Int
    var serverMissing: Bool
    var createdAt: String
}

func strictJSONInteger(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let candidate = number.doubleValue
    guard candidate.isFinite,
          candidate.rounded(.towardZero) == candidate,
          abs(candidate) <= 9_007_199_254_740_991,
          candidate >= Double(Int.min), candidate <= Double(Int.max) else { return nil }
    return Int(candidate)
}

func strictJSONBoolean(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
}

private func validConflictInstant(_ value: String) -> Bool {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if fractional.date(from: value) != nil { return true }
    return ISO8601DateFormatter().date(from: value) != nil
}

private func aliasedValue(_ object: [String: Any], _ camel: String, _ snake: String) -> Any? {
    object.keys.contains(camel) ? object[camel] : object[snake]
}

private func hasAliasedValue(_ object: [String: Any], _ camel: String, _ snake: String) -> Bool {
    object.keys.contains(camel) || object.keys.contains(snake)
}

func parseServerConflictSet(_ value: Any?) throws -> [RemoteServerConflict] {
    guard let values = value as? [Any] else {
        throw SyncError.validation("Sync conflict response has no conflict set. Existing local state was not changed.")
    }
    return try values.enumerated().map { index, value in
        guard let object = value as? [String: Any],
              let id = object["id"] as? String, UUID(uuidString: id) != nil,
              let entityType = aliasedValue(object, "entityType", "entity_type") as? String,
              supportedStores.contains(entityType),
              let entityId = aliasedValue(object, "entityId", "entity_id") as? String, !entityId.isEmpty,
              let mutationId = aliasedValue(object, "mutationId", "mutation_id") as? String,
              UUID(uuidString: mutationId) != nil,
              hasAliasedValue(object, "localPayload", "local_payload"),
              let localVersion = strictJSONInteger(aliasedValue(object, "localVersion", "local_version")),
              localVersion > 0,
              let serverVersion = strictJSONInteger(aliasedValue(object, "serverVersion", "server_version")),
              serverVersion >= 0,
              let createdAt = aliasedValue(object, "createdAt", "created_at") as? String,
              validConflictInstant(createdAt) else {
            throw SyncError.validation("Server conflict \(index) is incomplete or damaged. Existing conflicts were not changed.")
        }

        let localUpdatedAt = (aliasedValue(object, "localUpdatedAt", "local_updated_at") as? String) ?? createdAt
        guard validConflictInstant(localUpdatedAt) else {
            throw SyncError.validation("Server conflict \(index) has an invalid local timestamp. Existing conflicts were not changed.")
        }
        func optionalInstant(_ camel: String, _ snake: String) throws -> String? {
            let candidate = aliasedValue(object, camel, snake)
            if candidate == nil || candidate is NSNull { return nil }
            guard let timestamp = candidate as? String, validConflictInstant(timestamp) else {
                throw SyncError.validation("Server conflict \(index) has an invalid timestamp. Existing conflicts were not changed.")
            }
            return timestamp
        }

        let missingValue = aliasedValue(object, "serverMissing", "server_missing")
        let serverMissing: Bool
        if missingValue == nil || missingValue is NSNull {
            serverMissing = false
        } else if let parsed = strictJSONBoolean(missingValue) {
            serverMissing = parsed
        } else {
            throw SyncError.validation("Server conflict \(index) has an invalid missing-record flag. Existing conflicts were not changed.")
        }
        guard serverMissing || hasAliasedValue(object, "serverPayload", "server_payload") else {
            throw SyncError.validation("Server conflict \(index) has no recoverable cloud side. Existing conflicts were not changed.")
        }
        let baseValue = aliasedValue(object, "baseServerVersion", "base_server_version")
        let baseServerVersion: Int?
        if baseValue == nil || baseValue is NSNull {
            baseServerVersion = nil
        } else if let parsed = strictJSONInteger(baseValue), parsed >= 0 {
            baseServerVersion = parsed
        } else {
            throw SyncError.validation("Server conflict \(index) has an invalid base version. Existing conflicts were not changed.")
        }

        let serverPayloadValue: Any? = serverMissing
            ? nil
            : aliasedValue(object, "serverPayload", "server_payload")
        return RemoteServerConflict(
            id: id,
            entityType: entityType,
            entityId: entityId,
            mutationId: mutationId,
            baseServerVersion: baseServerVersion,
            localPayload: AnyCodable(aliasedValue(object, "localPayload", "local_payload")),
            localDeletedAt: try optionalInstant("localDeletedAt", "local_deleted_at"),
            localVersion: localVersion,
            localUpdatedAt: localUpdatedAt,
            serverPayload: AnyCodable(serverPayloadValue),
            serverDeletedAt: try optionalInstant("serverDeletedAt", "server_deleted_at"),
            serverVersion: serverVersion,
            serverMissing: serverMissing,
            createdAt: createdAt
        )
    }
}

private func localHistoryEntry(_ entry: AnyCodable, mutationId: String) -> [String: Any]? {
    guard let object = entry.value as? [String: Any],
          object["mutationId"] as? String == mutationId,
          object.keys.contains("payload"),
          let version = strictJSONInteger(object["version"]), version > 0,
          let updatedAt = object["updatedAt"] as? String, validConflictInstant(updatedAt) else { return nil }
    let deletedAt = object["deletedAt"]
    guard deletedAt == nil || deletedAt is NSNull
            || ((deletedAt as? String).map(validConflictInstant) == true) else { return nil }
    return object
}

func mergeServerConflicts(_ input: SyncMeta, conflicts remoteConflicts: [RemoteServerConflict]) throws -> SyncMeta {
    var meta = cloneMeta(input)
    guard Set(remoteConflicts.map(\.id)).count == remoteConflicts.count else {
        throw SyncError.validation("The server returned duplicate conflict identities. Existing conflicts were not changed.")
    }
    var representedMutationIds = Set(meta.outbox.map(\.mutationId))
    representedMutationIds.formUnion(meta.conflicts.flatMap { conflict in
        conflict.localHistory.compactMap { ($0.value as? [String: Any])?["mutationId"] as? String }
    })

    for remote in remoteConflicts {
        let key = syncEntityKey(remote.entityType, remote.entityId)
        if let index = meta.conflicts.firstIndex(where: { $0.id == remote.id }) {
            var existing = meta.conflicts[index]
            guard existing.entityType == remote.entityType,
                  existing.entityId == remote.entityId,
                  existing.mutationId == remote.mutationId,
                  let represented = existing.localHistory.compactMap({ localHistoryEntry($0, mutationId: remote.mutationId) }).first,
                  stableJson(represented["payload"]) == stableJson(remote.localPayload.value),
                  strictJSONInteger(represented["version"]) == remote.localVersion,
                  sameInstant(represented["updatedAt"] as? String, remote.localUpdatedAt),
                  sameInstant(represented["deletedAt"] as? String, remote.localDeletedAt) else {
                throw SyncError.validation("A server conflict mutation refers to different local data. Existing conflicts were not changed.")
            }
            if remote.serverVersion == existing.serverVersion {
                guard stableJson(existing.serverPayload.value) == stableJson(remote.serverPayload.value),
                      existing.serverMissing == remote.serverMissing,
                      sameInstant(existing.serverDeletedAt, remote.serverDeletedAt) else {
                    throw SyncError.validation("A server conflict version refers to different cloud data. Existing conflicts were not changed.")
                }
            } else if remote.serverVersion > existing.serverVersion {
                existing.serverPayload = remote.serverPayload
                existing.serverMissing = remote.serverMissing
                existing.serverDeletedAt = remote.serverDeletedAt
                existing.serverVersion = remote.serverVersion
                meta.conflicts[index] = existing
            }
        } else {
            guard !representedMutationIds.contains(remote.mutationId) else {
                throw SyncError.validation("A server conflict mutation identity collides with different pending data. Existing conflicts were not changed.")
            }
            representedMutationIds.insert(remote.mutationId)
            meta.conflicts.append(LocalConflict(
                id: remote.id,
                entityType: remote.entityType,
                entityId: remote.entityId,
                mutationId: remote.mutationId,
                baseServerVersion: remote.baseServerVersion,
                serverVersion: remote.serverVersion,
                localPayload: remote.localPayload,
                localDeletedAt: remote.localDeletedAt,
                localHistory: [AnyCodable([
                    "mutationId": remote.mutationId,
                    "payload": remote.localPayload.value ?? NSNull(),
                    "deletedAt": remote.localDeletedAt.map { $0 as Any } ?? NSNull(),
                    "updatedAt": remote.localUpdatedAt,
                    "version": remote.localVersion
                ])],
                serverPayload: remote.serverPayload,
                serverMissing: remote.serverMissing,
                serverDeletedAt: remote.serverDeletedAt,
                status: "unresolved",
                createdAt: remote.createdAt
            ))
        }
        var version = meta.versions[key] ?? VersionPair(local: 0, server: nil)
        version.local = max(version.local, remote.localVersion)
        version.server = max(version.server ?? 0, remote.serverVersion)
        meta.versions[key] = version
    }
    return meta
}
