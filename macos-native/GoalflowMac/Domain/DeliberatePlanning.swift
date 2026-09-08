import Foundation

/// Daily order decisions only. The local coordinator owns the atomic journal,
/// task projection and XP commit; opening Plan never calls this reducer.
enum DeliberatePlanning {
    struct Task { let id: String; let precedence: Int }
    struct Reply {
        let policy: [String: Any]
        let receipt: [String: Any]
        let xp: Int
        let ratings: [[String: Any]]
        let replay: Bool
    }
    private static func invalid() -> Error { SyncError.validation("Invalid planning command or policy.") }
    private static func id(_ value: Any?) -> Bool {
        guard let value = value as? String else { return false }
        return (1...240).contains(value.utf16.count)
    }
    private static func ids(_ value: Any?) throws -> [String] {
        guard let values = value as? [String], values.count <= 10_000,
              values.allSatisfy({ id($0) }), Set(values).count == values.count else { throw invalid() }
        return values
    }
    static func validate(_ command: [String: Any]) throws {
        let expected: Set<String> = ["schemaVersion", "operationId", "accountId", "localDate", "baselineRevision", "proposedOrder", "ratings", "maximumAcceptedXp", "capturedAt"]
        guard Set(command.keys) == expected || Set(command.keys) == expected.union(["priorityChanges"]) else { throw invalid() }
        guard ActionJSON.integer(command["schemaVersion"]) == 1, ActionJSON.identity(command["operationId"]), id(command["accountId"]),
              ActionJSON.day(command["localDate"]), command["baselineRevision"] is NSNull || command["baselineRevision"] is String,
              ActionJSON.instant(command["capturedAt"]), let cost = ActionJSON.integer(command["maximumAcceptedXp"]), (0...50).contains(cost),
              let ratings = command["ratings"] as? [[String: Any]], ratings.count <= 10_000 else { throw invalid() }
        _ = try ids(command["proposedOrder"])
        var seen = Set<String>()
        for rating in ratings {
            guard Set(rating.keys) == ["taskId", "excitement", "roi"], id(rating["taskId"]),
                  seen.insert(rating["taskId"] as! String).inserted,
                  let excitement = ActionJSON.integer(rating["excitement"]), (0...100).contains(excitement),
                  let roi = ActionJSON.integer(rating["roi"]), (0...100).contains(roi) else { throw invalid() }
        }
        if let raw = command["priorityChanges"] {
            guard let changes = raw as? [[String: Any]], changes.count <= 10_000 else { throw invalid() }
            seen.removeAll()
            for change in changes {
                guard Set(change.keys) == ["taskId", "isFrog"], id(change["taskId"]),
                      seen.insert(change["taskId"] as! String).inserted, stableJson(change["isFrog"]) == "true" else { throw invalid() }
            }
        }
    }
    /// Validate persisted and remote policy before allowing it to govern a day.
    static func validatePolicy(_ value: [String: Any], accountID: String, day: String) throws {
        guard Set(value.keys) == ["schemaVersion", "accountId", "localDate", "revision", "confirmedOrder", "acceptedReplans", "history"],
              ActionJSON.integer(value["schemaVersion"]) == 1,
              value["accountId"] as? String == accountID, value["localDate"] as? String == day,
              id(accountID), ActionJSON.day(day),
              value["revision"] is NSNull || value["revision"] is String,
              let count = ActionJSON.integer(value["acceptedReplans"]), count >= 0,
              let history = value["history"] as? [[String: Any]] else { throw invalid() }
        _ = try ids(value["confirmedOrder"])
        var seen = Set<String>()
        for receipt in history {
            guard Set(receipt.keys) == ["command", "code", "revision", "acceptedReplans", "actualDebit", "requiredCost", "order"],
                  let command = receipt["command"] as? [String: Any] else { throw invalid() }
            try validate(command)
            guard command["accountId"] as? String == accountID, command["localDate"] as? String == day,
                  seen.insert(command["operationId"] as! String).inserted,
                  let code = receipt["code"] as? String, ["APPLIED", "STALE_REVISION", "COST_CHANGED"].contains(code),
                  let cost = ActionJSON.integer(receipt["requiredCost"]), (0...50).contains(cost),
                  let debit = ActionJSON.integer(receipt["actualDebit"]), (0...cost).contains(debit),
                  let replans = ActionJSON.integer(receipt["acceptedReplans"]), replans >= 0,
                  receipt["revision"] is NSNull || receipt["revision"] is String else { throw invalid() }
            if code == "APPLIED" {
                guard receipt["revision"] as? String == command["operationId"] as? String,
                      cost <= ActionJSON.integer(command["maximumAcceptedXp"])! else { throw invalid() }
            } else if debit != 0 { throw invalid() }
            _ = try ids(receipt["order"])
        }
        if let last = history.last {
            guard stableJson(last["revision"]) == stableJson(value["revision"]),
                  ActionJSON.integer(last["acceptedReplans"]) == count else { throw invalid() }
        }
    }

    static func validateDay(_ response: [String: Any], accountID: String, day: String) throws {
        let required: Set<String> = ["schemaVersion", "accountId", "policy", "enforcementEnabled"]
        guard Set(response.keys) == required || Set(response.keys) == required.union(["records"]),
              ActionJSON.integer(response["schemaVersion"]) == 1,
              response["accountId"] as? String == accountID,
              strictJSONBoolean(response["enforcementEnabled"]) != nil,
              let policy = response["policy"] as? [String: Any] else { throw invalid() }
        try validatePolicy(policy, accountID: accountID, day: day)
        if let raw = response["records"] {
            guard let records = raw as? [[String: Any]] else { throw invalid() }
            var seen = Set<String>()
            for record in records {
                guard let type = record["entity_type"] as? String, ["tasks", "daily_plans", "progress"].contains(type),
                      let entityID = record["entity_id"] as? String, id(entityID),
                      record["user_id"] as? String == accountID, seen.insert("\(type):\(entityID)").inserted,
                      let version = ActionJSON.integer(record["version"]), version > 0,
                      let serverVersion = ActionJSON.integer(record["server_version"]), serverVersion > 0,
                      id(record["device_id"]), ActionJSON.instant(record["updated_at"]),
                      record["deleted_at"] is NSNull || ActionJSON.instant(record["deleted_at"]),
                      let payload = record["payload"] as? [String: Any] else { throw invalid() }
                switch type {
                case "daily_plans": guard entityID == day else { throw invalid() }
                case "progress": guard entityID == "singleton" else { throw invalid() }
                default:
                    let scheduled = payload["scheduledFor"]
                    let assigned = scheduled == nil || scheduled is NSNull ? payload["dateAssigned"] : scheduled
                    guard payload["id"] as? String == entityID, assigned as? String == day else { throw invalid() }
                }
            }
        }
    }

    static func initial(accountID: String, day: String, legacy: [String: Any]? = nil) throws -> [String: Any] {
        guard id(accountID), ActionJSON.day(day) else { throw invalid() }
        let order = try legacy.map { try ids($0["taskIds"]) } ?? []
        let revision: Any
        if let legacy {
            guard let confirmedAt = legacy["confirmedAt"] else { throw invalid() }
            revision = "legacy:\(day):\(confirmedAt)"
        } else { revision = NSNull() }
        return ["schemaVersion": 1, "accountId": accountID, "localDate": day, "revision": revision,
                "confirmedOrder": order, "acceptedReplans": 0, "history": [[String: Any]]()]
    }
    static func nextCost(_ policy: [String: Any], setting: String) -> Int {
        policy["revision"] is NSNull || (ActionJSON.integer(policy["acceptedReplans"]) ?? 0) < 3 || setting == "off" ? 0 : setting == "gentle" ? 25 : 50
    }
    static func changed(_ previous: [String], _ proposed: [String]) -> Bool {
        previous.filter { proposed.contains($0) } != proposed.filter { previous.contains($0) }
    }
    static func reconcile(_ proposed: [String], available: [Task]) throws -> [String] {
        guard Set(available.map(\.id)).count == available.count else { throw invalid() }
        let byID = Dictionary(uniqueKeysWithValues: available.map { ($0.id, $0.precedence) })
        var seen = Set<String>()
        let combined = (proposed + available.map(\.id)).filter { byID[$0] != nil && seen.insert($0).inserted }
        // Explicit original index preserves equal-precedence order on all runtimes.
        return combined.enumerated().sorted { a, b in
            let left = byID[a.element]!, right = byID[b.element]!
            return left == right ? a.offset < b.offset : left < right
        }.map(\.element)
    }
    static func apply(_ input: [String: Any], command: [String: Any], available: [Task], xp: Int, setting: String) throws -> Reply {
        try validate(command)
        guard input["accountId"] as? String == command["accountId"] as? String,
              input["localDate"] as? String == command["localDate"] as? String,
              xp >= 0, xp <= ActionJSON.maxSafeInteger, ["classic", "gentle", "off"].contains(setting),
              let count = ActionJSON.integer(input["acceptedReplans"]), count >= 0,
              var history = input["history"] as? [[String: Any]] else { throw invalid() }
        for prior in history {
            guard let priorCommand = prior["command"] as? [String: Any] else { throw invalid() }
            if priorCommand["operationId"] as? String == command["operationId"] as? String {
                guard stableJson(priorCommand) == stableJson(command) else { throw invalid() }
                return Reply(policy: input, receipt: prior, xp: xp, ratings: [], replay: true)
            }
        }
        let promoted = Set((command["priorityChanges"] as? [[String: Any]] ?? []).compactMap { $0["taskId"] as? String })
        let order = try reconcile(ids(command["proposedOrder"]), available: available.map {
            Task(id: $0.id, precedence: promoted.contains($0.id) && $0.precedence > 1 ? 1 : $0.precedence)
        })
        let previous = try ids(input["confirmedOrder"])
        let changed = !(input["revision"] is NSNull) && changed(previous.filter { id in available.contains { $0.id == id } }, order)
        let cost = changed ? nextCost(input, setting: setting) : 0
        let code = stableJson(command["baselineRevision"]) != stableJson(input["revision"]) ? "STALE_REVISION"
            : cost > (ActionJSON.integer(command["maximumAcceptedXp"]) ?? 0) ? "COST_CHANGED" : "APPLIED"
        let accepted = code == "APPLIED", debit = accepted ? min(xp, cost) : 0
        let revision = accepted ? command["operationId"]! : input["revision"]!
        let nextCount = count + (accepted && changed ? 1 : 0)
        guard nextCount <= ActionJSON.maxSafeInteger else { throw invalid() }
        let receiptOrder = try accepted ? order : reconcile(previous, available: available)
        let receipt: [String: Any] = ["command": command, "code": code, "revision": revision, "acceptedReplans": nextCount,
            "actualDebit": debit, "requiredCost": cost, "order": receiptOrder]
        history.append(receipt)
        var policy = input; policy["revision"] = revision; policy["acceptedReplans"] = nextCount; policy["history"] = history
        if accepted { policy["confirmedOrder"] = order }
        let ratings = accepted ? (command["ratings"] as! [[String: Any]]).filter { rating in available.contains { $0.id == rating["taskId"] as? String } } : []
        return Reply(policy: policy, receipt: receipt, xp: xp - debit, ratings: ratings, replay: false)
    }
}
