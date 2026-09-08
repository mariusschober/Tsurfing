package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONArray
import org.json.JSONObject

/** Shared daily order policy. Room owns durability and command publication. */
object DeliberatePlanning {
    data class Task(val id: String, val precedence: Int)
    data class Reply(val policy: JSONObject, val receipt: JSONObject, val xp: Long, val ratings: JSONArray, val replay: Boolean)
    private fun id(value: Any?) = value is String && value.length in 1..240
    private fun ids(value: Any?): List<String> {
        require(value is JSONArray && value.length() <= 10000) { "Invalid planning order." }
        val values = (0 until value.length()).map { value.get(it).also { item -> require(id(item)) } as String }
        require(values.toSet().size == values.size) { "Duplicate planning task." }
        return values
    }
    fun validate(command: JSONObject) {
        val expected = setOf("schemaVersion", "operationId", "accountId", "localDate", "baselineRevision", "proposedOrder", "ratings", "maximumAcceptedXp", "capturedAt")
        require(command.keys().asSequence().toSet().let { it == expected || it == expected + "priorityChanges" }
            && ActionJson.integer(command.opt("schemaVersion")) == 1L && ActionJson.identity(command.opt("operationId"))
            && id(command.opt("accountId")) && ActionJson.day(command.opt("localDate"))
            && (command.isNull("baselineRevision") || command.opt("baselineRevision") is String)
            && ActionJson.instant(command.opt("capturedAt"))
            && (ActionJson.integer(command.opt("maximumAcceptedXp")) ?: -1) in 0L..50L) { "Invalid planning command." }
        ids(command.opt("proposedOrder"))
        val ratings = command.getJSONArray("ratings")
        require(ratings.length() <= 10000)
        val seen = mutableSetOf<String>()
        for (i in 0 until ratings.length()) {
            val rating = ratings.getJSONObject(i)
            require(rating.keys().asSequence().toSet() == setOf("taskId", "excitement", "roi") && id(rating.opt("taskId"))
                && seen.add(rating.getString("taskId")) && (ActionJson.integer(rating.opt("excitement")) ?: -1) in 0L..100L
                && (ActionJson.integer(rating.opt("roi")) ?: -1) in 0L..100L) { "Invalid planning rating." }
        }
        command.optJSONArray("priorityChanges")?.let { changes ->
            require(changes.length() <= 10000); seen.clear()
            for (i in 0 until changes.length()) {
                val change = changes.getJSONObject(i)
                require(change.keys().asSequence().toSet() == setOf("taskId", "isFrog") && id(change.opt("taskId"))
                    && seen.add(change.getString("taskId")) && change.opt("isFrog") == true) { "Invalid planning priority." }
            }
        }
        require(!command.has("priorityChanges") || command.opt("priorityChanges") is JSONArray)
    }
    fun initial(accountId: String, day: String, legacy: JSONObject? = null): JSONObject {
        require(id(accountId) && ActionJson.day(day))
        val order = legacy?.let { ids(it.get("taskIds")) } ?: emptyList()
        return JSONObject().put("schemaVersion", 1).put("accountId", accountId).put("localDate", day)
            .put("revision", legacy?.let { "legacy:$day:${it.get("confirmedAt")}" } ?: JSONObject.NULL)
            .put("confirmedOrder", JSONArray(order)).put("acceptedReplans", 0).put("history", JSONArray())
    }
    fun nextCost(policy: JSONObject, setting: String): Int = if (policy.isNull("revision") || policy.getLong("acceptedReplans") < 3 || setting == "off") 0 else if (setting == "gentle") 25 else 50
    fun changed(previous: List<String>, proposed: List<String>): Boolean = previous.filter { it in proposed } != proposed.filter { it in previous }
    fun reconcile(proposed: List<String>, available: List<Task>): List<String> {
        require(available.map { it.id }.toSet().size == available.size)
        val byId = available.associateBy { it.id }
        return (proposed + available.map { it.id }).distinct().filter { it in byId }.sortedBy { byId.getValue(it).precedence }
    }
    fun apply(input: JSONObject, command: JSONObject, available: List<Task>, xp: Long, setting: String): Reply {
        validate(command)
        require(input.getString("accountId") == command.getString("accountId") && input.getString("localDate") == command.getString("localDate"))
        require(xp in 0..9007199254740991L && setting in setOf("classic", "gentle", "off"))
        val count = ActionJson.integer(input.opt("acceptedReplans")) ?: error("Invalid planning count.")
        val history = input.getJSONArray("history")
        for (i in 0 until history.length()) {
            val prior = history.getJSONObject(i)
            if (prior.getJSONObject("command").getString("operationId") == command.getString("operationId")) {
                require(ActionJson.canonical(prior.getJSONObject("command")) == ActionJson.canonical(command)) { "Planning identity has different content." }
                return Reply(input, prior, xp, JSONArray(), true)
            }
        }
        val changes = command.optJSONArray("priorityChanges") ?: JSONArray()
        val promoted = (0 until changes.length()).map { changes.getJSONObject(it).getString("taskId") }.toSet()
        val order = reconcile(ids(command.get("proposedOrder")), available.map { if (it.id in promoted && it.precedence > 1) it.copy(precedence = 1) else it })
        val previous = ids(input.get("confirmedOrder"))
        val changed = !input.isNull("revision") && changed(previous.filter { id -> available.any { it.id == id } }, order)
        val cost = if (changed) nextCost(input, setting) else 0
        val code = if (command.opt("baselineRevision") != input.opt("revision")) "STALE_REVISION" else if (cost > command.getInt("maximumAcceptedXp")) "COST_CHANGED" else "APPLIED"
        val accepted = code == "APPLIED"
        val debit = if (accepted) minOf(xp, cost.toLong()) else 0
        val revision = if (accepted) command.get("operationId") else input.get("revision")
        val nextCount = count + if (accepted && changed) 1 else 0
        require(nextCount <= 9007199254740991L)
        val receipt = JSONObject().put("command", JSONObject(command.toString())).put("code", code).put("revision", revision)
            .put("acceptedReplans", nextCount).put("actualDebit", debit).put("requiredCost", cost)
            .put("order", JSONArray(if (accepted) order else reconcile(previous, available)))
        val policy = JSONObject(input.toString()).put("revision", revision).put("acceptedReplans", nextCount)
        if (accepted) policy.put("confirmedOrder", JSONArray(order))
        policy.getJSONArray("history").put(receipt)
        val ratings = JSONArray()
        if (accepted) for (i in 0 until command.getJSONArray("ratings").length()) {
            val rating = command.getJSONArray("ratings").getJSONObject(i)
            if (available.any { it.id == rating.getString("taskId") }) ratings.put(rating)
        }
        return Reply(policy, receipt, xp - debit, ratings, false)
    }
}
