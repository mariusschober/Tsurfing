import Foundation

/// Pure transition logic. Durable admission must surround this with task/notes
/// validation, persistence and enqueue under the same local coordinator.
enum CausalFocus {
    struct Reply {
        let journal: [String: Any]
        let outcome: [String: Any]
        let duplicate: Bool
    }
    private static let kinds: Set<String> = ["start", "pause", "resume", "extend", "extendAndResume", "stop", "complete"]
    private static func nullableID(_ command: [String: Any], _ key: String) -> Bool {
        command[key] is NSNull || ActionJSON.identity(command[key])
    }
    static func validate(_ command: [String: Any]) throws {
        guard ActionJSON.integer(command["schemaVersion"]) == 1,
              ActionJSON.identity(command["actionId"]), ActionJSON.identity(command["accountId"]),
              ActionJSON.identity(command["sessionId"]), ActionJSON.identity(command["epoch"]),
              let kind = command["kind"] as? String, kinds.contains(kind),
              let actor = command["actorId"] as? String, (1...240).contains(actor.utf16.count),
              let task = command["taskId"] as? String, !task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, task.utf16.count <= 240,
              nullableID(command, "expectedRevision"), nullableID(command, "expectedCurrentSessionId"),
              ActionJSON.instant(command["capturedAt"]),
              (["start", "extend", "extendAndResume"].contains(kind)
                ? (ActionJSON.integer(command["durationSeconds"]) ?? 0) > 0 : command["durationSeconds"] is NSNull),
              kind != "start" || command["epoch"] as? String == command["actionId"] as? String else {
            throw SyncError.validation("The focus command is invalid. It was not admitted.")
        }
    }
    private static func validateProjection(_ projection: [String: Any]) throws {
        guard projection["pausedAt"] != nil, projection["endedAt"] != nil,
              ActionJSON.integer(projection["elapsedSeconds"]) != nil,
              SharedFocusSessionRecord(dictionary: projection) != nil else {
            throw SyncError.validation("The optional focus projection is damaged. Nothing was replaced.")
        }
    }
    static func initial(accountID: String, baseline: [String: Any]? = nil) throws -> [String: Any] {
        guard ActionJSON.identity(accountID) else { throw SyncError.validation("A focus journal needs an immutable account identity.") }
        var sessions: [String: Any] = [:]
        if let baseline {
            try validateProjection(baseline)
            let id = baseline["sessionId"] as! String
            sessions[id] = ["projection": baseline, "initialProjection": baseline, "epoch": id, "revision": id,
                "parents": [id: ["parent": NSNull(), "kind": "baseline"]]]
        }
        return ["schemaVersion": 1, "accountId": accountID, "currentSessionId": baseline?["sessionId"] ?? NSNull(),
            "sessions": sessions, "operations": [String: Any]()]
    }
    private static func milliseconds(_ text: String) throws -> Int64 {
        var input = text
        if let fraction = input.range(of: "\\.\\d+(?=Z|[+-]\\d{2}:\\d{2}$)", options: .regularExpression) {
            let digits = String(input[fraction].dropFirst())
            input.replaceSubrange(fraction, with: "." + String((digits + "000").prefix(3)))
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: input) ?? ISO8601DateFormatter().date(from: input) else {
            throw SyncError.validation("The focus timestamp is invalid.")
        }
        return Int64((date.timeIntervalSince1970 * 1000).rounded())
    }
    private static func format(_ milliseconds: Int64) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date(timeIntervalSince1970: Double(milliseconds) / 1000))
    }
    static func apply(_ input: [String: Any], command: [String: Any]) throws -> Reply {
        try validate(command)
        guard ActionJSON.integer(input["schemaVersion"]) == 1, input["accountId"] as? String == command["accountId"] as? String,
              var sessions = input["sessions"] as? [String: Any], var operations = input["operations"] as? [String: Any] else {
            throw SyncError.validation("Focus account scope mismatch or damaged journal.")
        }
        let id = command["actionId"] as! String
        if let prior = operations[id] as? [String: Any] {
            guard stableJson(prior["command"]) == stableJson(command), let outcome = prior["outcome"] as? [String: Any] else {
                throw SyncError.validation("Focus action identity has a different payload.")
            }
            return Reply(journal: input, outcome: outcome, duplicate: true)
        }
        var journal = input
        let sessionID = command["sessionId"] as! String
        var session = sessions[sessionID] as? [String: Any]
        func finish(_ accepted: Bool, _ code: String, revision: Any? = nil) -> Reply {
            let outcome: [String: Any] = ["accepted": accepted, "code": code, "revision": revision ?? session?["revision"] ?? NSNull()]
            operations[id] = ["command": command, "outcome": outcome]
            journal["sessions"] = sessions
            journal["operations"] = operations
            return Reply(journal: journal, outcome: outcome, duplicate: false)
        }
        let kind = command["kind"] as! String
        let time = command["capturedAt"] as! String
        if kind == "start" {
            if session != nil { return finish(false, "SESSION_EXISTS") }
            if stableJson(journal["currentSessionId"]) != stableJson(command["expectedCurrentSessionId"]) { return finish(false, "STALE_TARGET") }
            let current = (journal["currentSessionId"] as? String).flatMap { sessions[$0] as? [String: Any] }
            if stableJson(current?["revision"]) != stableJson(command["expectedRevision"]) { return finish(false, "STALE_REVISION") }
            let duration = ActionJSON.integer(command["durationSeconds"])!
            if !(60...86400).contains(duration) { return finish(false, "INVALID_RANGE") }
            let projection: [String: Any] = ["schemaVersion": 1, "sessionId": sessionID, "taskId": command["taskId"]!, "phase": "active",
                "plannedDurationSeconds": duration, "startedAt": time, "updatedAt": time, "elapsedSeconds": 0, "pausedAt": NSNull(), "endedAt": NSNull()]
            sessions[sessionID] = ["epoch": command["epoch"]!, "revision": id, "projection": projection, "initialProjection": projection,
                "parents": [id: ["parent": NSNull(), "kind": "start"]]]
            journal["currentSessionId"] = sessionID
            return finish(true, "APPLIED", revision: id)
        }
        guard let existing = session, journal["currentSessionId"] as? String == sessionID,
              command["expectedCurrentSessionId"] as? String == sessionID,
              existing["epoch"] as? String == command["epoch"] as? String,
              let focus = existing["projection"] as? [String: Any], focus["taskId"] as? String == command["taskId"] as? String else {
            return finish(false, "STALE_TARGET")
        }
        try validateProjection(focus)
        let phase = focus["phase"] as! String
        if ["stopped", "completed"].contains(phase) { return finish(false, "TERMINAL") }
        guard var parents = existing["parents"] as? [String: Any] else { throw SyncError.validation("The focus ancestry is damaged.") }
        if stableJson(existing["revision"]) != stableJson(command["expectedRevision"]) {
            var parent = existing["revision"] as? String
            var visited = Set<String>()
            while let value = parent, value != command["expectedRevision"] as? String, visited.insert(value).inserted {
                guard let step = parents[value] as? [String: Any], step["kind"] as? String == "extend" else { break }
                parent = step["parent"] as? String
            }
            if kind != "extend" || command["expectedRevision"] is NSNull || parent != command["expectedRevision"] as? String {
                return finish(false, "STALE_REVISION")
            }
        }
        if (kind == "pause" && phase != "active") || (["resume", "extendAndResume"].contains(kind) && phase != "paused") { return finish(false, "INVALID_PHASE") }
        var next = focus
        if ["extend", "extendAndResume"].contains(kind) {
            let duration = ActionJSON.integer(focus["plannedDurationSeconds"])! + ActionJSON.integer(command["durationSeconds"])!
            if duration > 86400 { return finish(false, "INVALID_RANGE") }
            next["plannedDurationSeconds"] = duration
        }
        let now = try milliseconds(time)
        let elapsed = Int64(ActionJSON.integer(focus["elapsedSeconds"])!) + (phase == "active" ? max(0, now - (try milliseconds(focus["startedAt"] as! String))) / 1000 : 0)
        if elapsed > ActionJSON.maxSafeInteger { return finish(false, "INVALID_RANGE") }
        if ["pause", "stop", "complete"].contains(kind) {
            next["elapsedSeconds"] = Int(elapsed)
            next["startedAt"] = time
            next["phase"] = kind == "pause" ? "paused" : kind == "stop" ? "stopped" : "completed"
            next["pausedAt"] = kind == "pause" ? time : NSNull()
            next["endedAt"] = kind == "pause" ? NSNull() : time
        } else if ["resume", "extendAndResume"].contains(kind) {
            next["startedAt"] = time
            next["phase"] = "active"
            next["pausedAt"] = NSNull()
            next["endedAt"] = NSNull()
        }
        next["updatedAt"] = try format(max(now, milliseconds(focus["updatedAt"] as! String)))
        try validateProjection(next)
        parents[id] = ["parent": existing["revision"]!, "kind": kind]
        session?["parents"] = parents
        session?["projection"] = next
        session?["revision"] = id
        sessions[sessionID] = session
        return finish(true, "APPLIED", revision: id)
    }
}
