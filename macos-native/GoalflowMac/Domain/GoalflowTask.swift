import Foundation
enum SchedulePrecision: String, Codable, Sendable { case day = "day"; case month = "month" }
enum TaskStatus: String, Codable, Sendable { case open = "open"; case completed = "completed"; case brokenDown = "broken_down"; case dropped = "dropped"; case archived = "archived" }
enum TaskSource: String, Codable, Sendable { case manual = "manual"; case habit = "habit"; case telegram = "telegram"; case share = "share"; case ai = "ai"; case migration = "migration" }
enum FlowState: String, Codable, Sendable, CaseIterable { case distracted = "distracted"; case good = "good"; case high = "high"; case flow = "flow" }
extension FlowState {
    var displayTitle: String {
        switch self { case .distracted: return "I felt distracted"; case .good: return "My focus was good"; case .high: return "I felt highly focused"; case .flow: return "I experienced \"flow\"" }
    }
    var shortLabel: String {
        switch self { case .distracted: return "Distracted"; case .good: return "Good"; case .high: return "High"; case .flow: return "Flow" }
    }
}
struct GoalflowTask: Codable, Equatable, Sendable, Identifiable {
    var id: String; var title: String; var notes: String; var tags: [String]; var schedulePrecision: SchedulePrecision; var scheduledFor: String; var scheduledTime: String?; var plannedOrder: Int; var status: TaskStatus; var isFrog: Bool; var frogFailures: Int; var beforeFrog: Bool; var source: TaskSource; var parentTaskId: String?; var habitId: String?; var goalId: String?; var createdAt: String; var updatedAt: String; var version: Int; var durationMinutes: Int; var extraJson: String
    init(id: String, title: String, notes: String = "", tags: [String] = [], schedulePrecision: SchedulePrecision = .day, scheduledFor: String, scheduledTime: String? = nil, plannedOrder: Int = 0, status: TaskStatus = .open, isFrog: Bool = false, frogFailures: Int = 0, beforeFrog: Bool = false, source: TaskSource = .manual, parentTaskId: String? = nil, habitId: String? = nil, goalId: String? = nil, createdAt: String = ISO8601DateFormatter().string(from: Date()), updatedAt: String = ISO8601DateFormatter().string(from: Date()), version: Int = 1, durationMinutes: Int = 25, extraJson: String = "{}") {
        self.id = id; self.title = title.trimmingCharacters(in: .whitespacesAndNewlines); self.notes = notes; self.tags = tags; self.schedulePrecision = schedulePrecision; self.scheduledFor = scheduledFor; self.scheduledTime = scheduledTime; self.plannedOrder = plannedOrder; self.status = status; self.isFrog = isFrog; self.frogFailures = frogFailures; self.beforeFrog = beforeFrog; self.source = source; self.parentTaskId = parentTaskId; self.habitId = habitId; self.goalId = goalId; self.createdAt = createdAt; self.updatedAt = updatedAt; self.version = version; self.durationMinutes = max(1, min(1440, durationMinutes)); self.extraJson = extraJson
    }
    func withCompleted(at now: Date, actualDurationMinutes: Int, flowState: FlowState?) throws -> GoalflowTask {
        var copy = self; copy.status = .completed; let iso = ISO8601DateFormatter().string(from: now); copy.updatedAt = iso; copy.version = version + 1
        var dict = try decodedExtraJSON()
        dict["actualDuration"] = max(1, actualDurationMinutes); dict["completedAt"] = iso
        if let flow = flowState { dict["flowState"] = flow.rawValue }
        copy.extraJson = try encodedExtraJSON(dict)
        return copy
    }
    func withFlowState(_ flow: FlowState) throws -> GoalflowTask {
        var copy = self; copy.updatedAt = ISO8601DateFormatter().string(from: Date()); copy.version = version + 1
        var dict = try decodedExtraJSON()
        dict["flowState"] = flow.rawValue
        copy.extraJson = try encodedExtraJSON(dict)
        return copy
    }

    private func decodedExtraJSON() throws -> [String: Any] {
        guard let data = extraJson.data(using: .utf8),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SyncError.validation("Task metadata is damaged. The task was not changed.")
        }
        return object
    }

    private func encodedExtraJSON(_ object: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard let value = String(data: data, encoding: .utf8) else {
            throw SyncError.validation("Task metadata could not be encoded. The task was not changed.")
        }
        return value
    }
    var flowState: FlowState? {
        guard let data = extraJson.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let raw = obj["flowState"] as? String else { return nil }
        return FlowState(rawValue: raw)
    }
    var actualDurationMinutes: Int? {
        guard let data = extraJson.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let v = obj["actualDuration"] as? Int else { return nil }
        return v
    }
}
extension GoalflowTask {
    var isOpen: Bool { status == .open }
    var isCompleted: Bool { status == .completed }
    var plannedDurationSeconds: Int { durationMinutes * 60 }
    func toDictionary() throws -> [String: Any] {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        enc.outputFormatting = [.sortedKeys]
        let data = try enc.encode(self)
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SyncError.validation("Task data could not be encoded. The task was not changed.")
        }
        return obj
    }

    /// Converts the native model to the shared web/server task payload. Native
    /// aliases remain present for older clients, while canonical fields make a
    /// completion or schedule change mean the same thing on every platform.
    func toSyncDictionary() throws -> [String: Any] {
        var payload = try decodedExtraJSON()
        payload["id"] = id
        payload["title"] = title
        payload["description"] = notes
        payload["notes"] = notes
        payload["hashtags"] = tags
        payload["tags"] = tags
        payload["schedulePrecision"] = schedulePrecision.rawValue
        payload["scheduledFor"] = scheduledFor
        payload["dateAssigned"] = schedulePrecision == .month ? "\(scheduledFor)-01" : scheduledFor
        payload["plannedOrder"] = plannedOrder
        payload["status"] = status.rawValue
        payload["lifecycleStatus"] = status.rawValue
        payload["completed"] = status == .completed || status == .brokenDown
        payload["wontDo"] = status == .dropped
        payload["isFrog"] = isFrog
        payload["frogFailures"] = frogFailures
        payload["beforeFrog"] = beforeFrog
        payload["source"] = source.rawValue
        payload["createdAt"] = try Self.syncMilliseconds(from: createdAt, field: "creation")
        payload["updatedAt"] = try Self.syncMilliseconds(from: updatedAt, field: "update")
        payload["version"] = version
        payload["duration"] = durationMinutes
        payload["durationMinutes"] = durationMinutes
        payload["estimatedMinutes"] = durationMinutes

        if let scheduledTime { payload["scheduledTime"] = scheduledTime } else { payload.removeValue(forKey: "scheduledTime") }
        if let parentTaskId { payload["parentTaskId"] = parentTaskId } else { payload.removeValue(forKey: "parentTaskId") }
        if let habitId { payload["habitId"] = habitId } else { payload.removeValue(forKey: "habitId") }
        if let goalId { payload["goalId"] = goalId } else { payload.removeValue(forKey: "goalId") }
        if let completedAt = payload["completedAt"] as? String,
           let milliseconds = try? Self.syncMilliseconds(from: completedAt, field: "completion") {
            payload["completedAt"] = milliseconds
        }
        return payload
    }

    /// Accepts either the shared browser payload or the native persisted shape.
    /// Unknown JSON fields are retained in `extraJson` and are emitted again.
    init(syncDictionary payload: [String: Any]) throws {
        guard let id = payload["id"] as? String, !id.isEmpty,
              let title = payload["title"] as? String,
              !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw SyncError.validation("The synchronized task has no durable identity or title. Nothing was applied.")
        }
        let precisionRaw = try Self.optionalTaskString(payload, keys: ["schedulePrecision"], field: "schedule precision")
        guard let precision = SchedulePrecision(rawValue: precisionRaw ?? "day") else {
            throw SyncError.validation("The synchronized task has an invalid schedule precision. Nothing was applied.")
        }
        let rawSchedule = try Self.optionalTaskString(payload, keys: ["scheduledFor", "dateAssigned"], field: "schedule") ?? ""
        let scheduledFor = precision == .month ? String(rawSchedule.prefix(7)) : rawSchedule
        guard (precision == .day && isRealDay(scheduledFor))
                || (precision == .month && isRealMonth(scheduledFor)) else {
            throw SyncError.validation("The synchronized task has an invalid schedule. Nothing was applied.")
        }
        let scheduledTime = try Self.optionalTaskString(payload, keys: ["scheduledTime"], field: "time")
        if let scheduledTime {
            let expression = try NSRegularExpression(pattern: #"^(?:[01]\d|2[0-3]):[0-5]\d$"#)
            let range = NSRange(scheduledTime.startIndex..., in: scheduledTime)
            guard precision == .day,
                  expression.firstMatch(in: scheduledTime, range: range) != nil else {
                throw SyncError.validation("The synchronized task has an invalid time. Nothing was applied.")
            }
        }

        let completed = try Self.taskBoolean(payload["completed"], default: false, field: "completion flag")
        let wontDo = try Self.taskBoolean(payload["wontDo"], default: false, field: "archive flag")
        let statusValue = try Self.optionalTaskString(payload, keys: ["lifecycleStatus", "status"], field: "lifecycle status")
        let status: TaskStatus
        if let statusValue {
            guard let parsed = TaskStatus(rawValue: statusValue) else {
                throw SyncError.validation("The synchronized task lifecycle status is invalid. Nothing was applied.")
            }
            status = parsed
        } else {
            status = wontDo ? .dropped : (completed ? .completed : .open)
        }
        let representsCompleted = status == .completed || status == .brokenDown
        if statusValue != nil, payload.keys.contains("completed"), completed != representsCompleted {
            throw SyncError.validation("The synchronized task has contradictory completion state. Nothing was applied.")
        }
        if statusValue != nil, payload.keys.contains("wontDo"), wontDo != (status == .dropped) {
            throw SyncError.validation("The synchronized task has contradictory archive state. Nothing was applied.")
        }
        let sourceValue = try Self.optionalTaskString(payload, keys: ["source"], field: "source")
        let source: TaskSource
        if let sourceValue {
            guard let parsed = TaskSource(rawValue: sourceValue) else {
                throw SyncError.validation("The synchronized task source is invalid. Nothing was applied.")
            }
            source = parsed
        } else {
            source = .migration
        }
        let createdAt = try Self.nativeTimestamp(payload["createdAt"], field: "creation")
        let updatedAt = try Self.nativeTimestamp(payload["updatedAt"], field: "update")
        let version = try Self.taskInteger(payload["version"], default: 1, minimum: 1, field: "version")
        let duration = try Self.taskInteger(
            payload["duration"] ?? payload["durationMinutes"] ?? payload["estimatedMinutes"],
            default: 25,
            minimum: 1,
            field: "duration"
        )
        guard duration <= 1_440 else {
            throw SyncError.validation("The synchronized task duration is invalid. Nothing was applied.")
        }
        let plannedOrder = try Self.taskInteger(payload["plannedOrder"], default: 0, minimum: 0, field: "order")
        let frogFailures = try Self.taskInteger(
            payload["frogFailures"] ?? payload["rescheduleCount"],
            default: 0,
            minimum: 0,
            field: "frog failure count"
        )
        let notes = try Self.optionalTaskString(payload, keys: ["description", "notes"], field: "notes") ?? ""
        let tags = try Self.taskStrings(payload, keys: ["hashtags", "tags"], field: "tags")
        let parentTaskId = try Self.optionalTaskString(payload, keys: ["parentTaskId"], field: "parent task identity")
        let habitId = try Self.optionalTaskString(payload, keys: ["habitId"], field: "habit identity")
        let goalId = try Self.optionalTaskString(payload, keys: ["goalId"], field: "goal identity")

        var extra: [String: Any] = [:]
        if let existing = payload["extraJson"] as? String {
            guard let data = existing.data(using: .utf8),
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw SyncError.validation("The synchronized task metadata is damaged. Nothing was applied.")
            }
            extra = object
        }
        let modeledKeys: Set<String> = [
            "id", "title", "description", "notes", "hashtags", "tags",
            "schedulePrecision", "scheduledFor", "dateAssigned", "scheduledTime",
            "plannedOrder", "status", "lifecycleStatus", "completed", "wontDo",
            "isFrog", "frogFailures", "rescheduleCount", "beforeFrog", "source",
            "parentTaskId", "habitId", "goalId", "createdAt", "updatedAt", "version",
            "duration", "durationMinutes", "estimatedMinutes", "extraJson"
        ]
        for (key, value) in payload where !modeledKeys.contains(key) { extra[key] = value }
        let extraData = try JSONSerialization.data(withJSONObject: extra, options: [.sortedKeys])
        guard let extraJson = String(data: extraData, encoding: .utf8) else {
            throw SyncError.validation("The synchronized task metadata could not be preserved. Nothing was applied.")
        }

        self.init(
            id: id,
            title: title,
            notes: notes,
            tags: tags,
            schedulePrecision: precision,
            scheduledFor: scheduledFor,
            scheduledTime: scheduledTime,
            plannedOrder: plannedOrder,
            status: status,
            isFrog: try Self.taskBoolean(payload["isFrog"], default: false, field: "frog flag"),
            frogFailures: frogFailures,
            beforeFrog: try Self.taskBoolean(payload["beforeFrog"], default: false, field: "before-frog flag"),
            source: source,
            parentTaskId: parentTaskId,
            habitId: habitId,
            goalId: goalId,
            createdAt: createdAt,
            updatedAt: updatedAt,
            version: version,
            durationMinutes: duration,
            extraJson: extraJson
        )
    }

    private static func taskBoolean(_ value: Any?, default fallback: Bool, field: String) throws -> Bool {
        if value == nil || value is NSNull { return fallback }
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID() else {
            throw SyncError.validation("The synchronized task \(field) is invalid. Nothing was applied.")
        }
        return number.boolValue
    }

    private static func optionalTaskString(
        _ payload: [String: Any],
        keys: [String],
        field: String
    ) throws -> String? {
        guard let key = keys.first(where: { payload.keys.contains($0) }) else { return nil }
        let value = payload[key]
        if value == nil || value is NSNull { return nil }
        guard let string = value as? String else {
            throw SyncError.validation("The synchronized task \(field) is invalid. Nothing was applied.")
        }
        return string
    }

    private static func taskStrings(
        _ payload: [String: Any],
        keys: [String],
        field: String
    ) throws -> [String] {
        guard let key = keys.first(where: { payload.keys.contains($0) }) else { return [] }
        let value = payload[key]
        if value == nil || value is NSNull { return [] }
        guard let values = value as? [Any], values.allSatisfy({ $0 is String }) else {
            throw SyncError.validation("The synchronized task \(field) are invalid. Nothing was applied.")
        }
        return values.compactMap { $0 as? String }
    }

    private static func taskInteger(
        _ value: Any?,
        default fallback: Int,
        minimum: Int,
        field: String
    ) throws -> Int {
        if value == nil || value is NSNull { return fallback }
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite,
              number.doubleValue.rounded(.towardZero) == number.doubleValue,
              number.doubleValue >= Double(minimum),
              number.doubleValue <= Double(Int.max) else {
            throw SyncError.validation("The synchronized task \(field) is invalid. Nothing was applied.")
        }
        return number.intValue
    }

    private static func nativeTimestamp(_ value: Any?, field: String) throws -> String {
        if let text = value as? String, parseSyncDate(text) != nil { return text }
        if let number = value as? NSNumber,
           CFGetTypeID(number) != CFBooleanGetTypeID(),
           number.doubleValue.isFinite, number.doubleValue >= 0 {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return formatter.string(from: Date(timeIntervalSince1970: number.doubleValue / 1_000))
        }
        throw SyncError.validation("The synchronized task \(field) timestamp is invalid. Nothing was applied.")
    }

    private static func syncMilliseconds(from value: String, field: String) throws -> Int64 {
        guard let date = parseSyncDate(value) else {
            throw SyncError.validation("The local task \(field) timestamp is invalid. The task remains pending.")
        }
        let milliseconds = date.timeIntervalSince1970 * 1_000
        guard milliseconds.isFinite,
              milliseconds >= Double(Int64.min), milliseconds <= Double(Int64.max) else {
            throw SyncError.validation("The local task \(field) timestamp is out of range. The task remains pending.")
        }
        return Int64(milliseconds.rounded())
    }

    private static func parseSyncDate(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
private func groupRank(_ task: GoalflowTask) -> Int {
    if task.beforeFrog, task.habitId != nil { return 0 }
    if task.isFrog { return 1 }
    return 2
}
private func optionalRank(_ value: Int?) -> Int { value ?? Int.max }
func compareQueueCandidates(_ left: GoalflowTask, _ right: GoalflowTask) -> Int {
    let g = groupRank(left) - groupRank(right)
    if g != 0 { return g }
    if left.plannedOrder != right.plannedOrder { return left.plannedOrder < right.plannedOrder ? -1 : 1 }

    let lt = left.scheduledTime ?? "99:99"
    let rt = right.scheduledTime ?? "99:99"
    if lt != rt { return lt < rt ? -1 : 1 }
    if left.createdAt != right.createdAt { return left.createdAt < right.createdAt ? -1 : 1 }
    if left.id != right.id { return left.id < right.id ? -1 : 1 }
    return 0
}
func goalflowTaskComparator(_ left: GoalflowTask, _ right: GoalflowTask) -> Bool { compareQueueCandidates(left, right) < 0 }
func buildTodayQueue(tasks: [GoalflowTask], today: String) -> [GoalflowTask] {
    tasks.filter { $0.isOpen && $0.schedulePrecision == .day && $0.scheduledFor == today }.sorted(by: goalflowTaskComparator)
}
