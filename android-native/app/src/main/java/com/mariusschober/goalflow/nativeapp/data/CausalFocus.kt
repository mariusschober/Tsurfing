package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONObject
import java.time.Instant

/** State transitions only. Room admission owns task checks, notes, enqueue and
 * the atomic commit; UI code must never save a precomputed projection. */
object CausalFocus {
    data class Reply(val journal: JSONObject, val outcome: JSONObject, val duplicate: Boolean)
    private val kinds = setOf("start", "pause", "resume", "extend", "extendAndResume", "stop", "complete")
    private fun nullableId(value: JSONObject, key: String) = value.has(key) && (value.isNull(key) || ActionJson.identity(value.opt(key)))
    fun validate(command: JSONObject) {
        val kind = command.opt("kind")
        val actor = command.opt("actorId")
        val task = command.opt("taskId")
        val duration = ActionJson.integer(command.opt("durationSeconds"))
        require(ActionJson.integer(command.opt("schemaVersion")) == 1L
            && ActionJson.identity(command.opt("actionId")) && ActionJson.identity(command.opt("accountId"))
            && ActionJson.identity(command.opt("sessionId")) && ActionJson.identity(command.opt("epoch"))
            && kind in kinds && actor is String && actor.length in 1..240
            && task is String && task.isNotBlank() && task.length <= 240
            && nullableId(command, "expectedRevision") && nullableId(command, "expectedCurrentSessionId")
            && ActionJson.instant(command.opt("capturedAt"))
            && (if (kind in setOf("start", "extend", "extendAndResume")) duration != null && duration > 0
                else command.has("durationSeconds") && command.isNull("durationSeconds"))
            && (kind != "start" || command.opt("epoch") == command.opt("actionId"))) {
            "The focus command is invalid. It was not admitted."
        }
    }
    private fun validateProjection(projection: JSONObject) {
        require(ActionJson.integer(projection.opt("schemaVersion")) == 1L
            && projection.has("pausedAt") && projection.has("endedAt")
            && ActionJson.integer(projection.opt("elapsedSeconds")) != null) { "The focus projection is damaged." }
        NativeFocusSessionRecord.fromJson(projection)
    }
    fun initial(accountId: String, baseline: JSONObject? = null): JSONObject {
        require(ActionJson.identity(accountId)) { "A focus journal needs an immutable account identity." }
        val sessions = JSONObject()
        if (baseline != null) {
            validateProjection(baseline)
            val id = baseline.getString("sessionId")
            sessions.put(id, JSONObject().put("projection", JSONObject(baseline.toString()))
                .put("initialProjection", JSONObject(baseline.toString())).put("epoch", id).put("revision", id)
                .put("parents", JSONObject().put(id, JSONObject().put("parent", JSONObject.NULL).put("kind", "baseline"))))
        }
        return JSONObject().put("schemaVersion", 1).put("accountId", accountId)
            .put("currentSessionId", baseline?.getString("sessionId") ?: JSONObject.NULL)
            .put("sessions", sessions).put("operations", JSONObject())
    }
    fun apply(input: JSONObject, command: JSONObject): Reply {
        validate(command)
        require(ActionJson.integer(input.opt("schemaVersion")) == 1L && input.opt("accountId") == command.opt("accountId")) { "Focus account scope mismatch." }
        val id = command.getString("actionId")
        val prior = input.getJSONObject("operations").optJSONObject(id)
        if (prior != null) {
            require(ActionJson.canonical(prior.getJSONObject("command")) == ActionJson.canonical(command)) { "Focus action identity has a different payload." }
            return Reply(input, prior.getJSONObject("outcome"), true)
        }
        val journal = JSONObject(input.toString())
        val sessions = journal.getJSONObject("sessions")
        val sessionId = command.getString("sessionId")
        val session = sessions.optJSONObject(sessionId)
        fun finish(accepted: Boolean, code: String, revision: Any? = session?.opt("revision")): Reply {
            val outcome = JSONObject().put("accepted", accepted).put("code", code).put("revision", revision ?: JSONObject.NULL)
            journal.getJSONObject("operations").put(id, JSONObject().put("command", JSONObject(command.toString())).put("outcome", outcome))
            return Reply(journal, outcome, false)
        }
        val kind = command.getString("kind")
        val time = command.getString("capturedAt")
        if (kind == "start") {
            if (session != null) return finish(false, "SESSION_EXISTS")
            if (journal.opt("currentSessionId") != command.opt("expectedCurrentSessionId")) return finish(false, "STALE_TARGET")
            val current = if (journal.isNull("currentSessionId")) null else sessions.getJSONObject(journal.getString("currentSessionId"))
            if ((current?.opt("revision") ?: JSONObject.NULL) != command.opt("expectedRevision")) return finish(false, "STALE_REVISION")
            val duration = command.getLong("durationSeconds")
            if (duration !in 60..86400) return finish(false, "INVALID_RANGE")
            val projection = JSONObject().put("schemaVersion", 1).put("sessionId", sessionId).put("taskId", command.getString("taskId"))
                .put("phase", "active").put("plannedDurationSeconds", duration).put("startedAt", time).put("updatedAt", time)
                .put("elapsedSeconds", 0).put("pausedAt", JSONObject.NULL).put("endedAt", JSONObject.NULL)
            sessions.put(sessionId, JSONObject().put("epoch", command.getString("epoch")).put("revision", id)
                .put("projection", projection).put("initialProjection", JSONObject(projection.toString()))
                .put("parents", JSONObject().put(id, JSONObject().put("parent", JSONObject.NULL).put("kind", "start"))))
            journal.put("currentSessionId", sessionId)
            return finish(true, "APPLIED", id)
        }
        if (session == null || journal.opt("currentSessionId") != sessionId || command.opt("expectedCurrentSessionId") != sessionId
            || session.opt("epoch") != command.opt("epoch") || session.getJSONObject("projection").opt("taskId") != command.opt("taskId")) return finish(false, "STALE_TARGET")
        val focus = session.getJSONObject("projection")
        validateProjection(focus)
        val phase = focus.getString("phase")
        if (phase in setOf("stopped", "completed")) return finish(false, "TERMINAL")
        if (session.opt("revision") != command.opt("expectedRevision")) {
            var parent: Any? = session.opt("revision")
            val visited = mutableSetOf<String>()
            while (parent is String && parent != command.opt("expectedRevision") && visited.add(parent)) {
                val step = session.getJSONObject("parents").optJSONObject(parent)
                if (step == null || step.opt("kind") != "extend") break
                parent = step.opt("parent")
            }
            if (kind != "extend" || command.isNull("expectedRevision") || parent != command.opt("expectedRevision")) return finish(false, "STALE_REVISION")
        }
        if ((kind == "pause" && phase != "active") || (kind in setOf("resume", "extendAndResume") && phase != "paused")) return finish(false, "INVALID_PHASE")
        val next = JSONObject(focus.toString())
        if (kind in setOf("extend", "extendAndResume")) {
            val duration = focus.getLong("plannedDurationSeconds") + command.getLong("durationSeconds")
            if (duration > 86400) return finish(false, "INVALID_RANGE")
            next.put("plannedDurationSeconds", duration)
        }
        val now = Instant.parse(time)
        val elapsed = focus.getLong("elapsedSeconds") + if (phase == "active") {
            ((now.toEpochMilli() - Instant.parse(focus.getString("startedAt")).toEpochMilli()).coerceAtLeast(0L) / 1000)
        } else 0L
        if (elapsed > ActionJson.MAX_SAFE_INTEGER) return finish(false, "INVALID_RANGE")
        if (kind in setOf("pause", "stop", "complete")) {
            next.put("elapsedSeconds", elapsed).put("startedAt", time)
                .put("phase", if (kind == "pause") "paused" else if (kind == "stop") "stopped" else "completed")
                .put("pausedAt", if (kind == "pause") time else JSONObject.NULL)
                .put("endedAt", if (kind == "pause") JSONObject.NULL else time)
        } else if (kind in setOf("resume", "extendAndResume")) {
            next.put("startedAt", time).put("phase", "active").put("pausedAt", JSONObject.NULL).put("endedAt", JSONObject.NULL)
        }
        next.put("updatedAt", ActionJson.instantFormatter.format(Instant.ofEpochMilli(maxOf(now.toEpochMilli(), Instant.parse(focus.getString("updatedAt")).toEpochMilli()))))
        validateProjection(next)
        session.getJSONObject("parents").put(id, JSONObject().put("parent", session.getString("revision")).put("kind", kind))
        session.put("projection", next).put("revision", id)
        return finish(true, "APPLIED", id)
    }
}
