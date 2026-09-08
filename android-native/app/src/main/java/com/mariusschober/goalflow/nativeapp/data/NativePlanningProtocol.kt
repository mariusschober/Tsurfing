package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

object NativePlanningProtocol {
    private fun same(a: Any?, b: Any?) = ActionJson.canonical(a) == ActionJson.canonical(b)
    fun review(accountId: String, command: JSONObject, value: JSONObject): JSONObject {
        require(value.keys().asSequence().toSet() == setOf("schemaVersion", "accountId", "operationId", "response", "policy", "records", "missingTaskIds"))
        require(value.opt("schemaVersion") == 1 && value.opt("accountId") == accountId && value.opt("operationId") == command.opt("operationId"))
        response(accountId, command, value.getJSONObject("response"))
        val day = command.getString("localDate")
        val policy = policy(accountId, day, value.getJSONObject("policy"))
        val history = value.getJSONObject("response").getJSONObject("policy").getJSONArray("history")
        for (i in 0 until history.length()) require(same(history.get(i), policy.getJSONArray("history").opt(i)))
        val proposed = command.getJSONArray("proposedOrder").let { ids -> (0 until ids.length()).map(ids::getString).toSet() }
        val keys = mutableSetOf<String>()
        val records = value.getJSONArray("records")
        for (i in 0 until records.length()) {
            val row = records.getJSONObject(i); val type = row.getString("entity_type"); val id = row.getString("entity_id")
            require(row.opt("user_id") == accountId && type in setOf("tasks", "progress", "daily_plans") && keys.add("$type:$id"))
            require((ActionJson.integer(row.opt("server_version")) ?: 0) > 0 && (ActionJson.integer(row.opt("version")) ?: 0) > 0)
            require(row.getString("device_id").isNotEmpty() && row.has("deleted_at") && (row.isNull("deleted_at") || row.opt("deleted_at") is String))
            Instant.parse(row.getString("updated_at"))
            val payload = row.getJSONObject("payload")
            when (type) {
                "progress" -> require(id == "singleton")
                "daily_plans" -> require(id == day)
                "tasks" -> require(payload.opt("id") == id && (id in proposed || (if (!payload.isNull("scheduledFor")) payload.opt("scheduledFor") else payload.opt("dateAssigned")) == day))
            }
        }
        val missing = value.getJSONArray("missingTaskIds"); order(missing)
        val missingIds = (0 until missing.length()).map(missing::getString).toSet()
        require(missingIds.all { it in proposed && "tasks:$it" !in keys } && proposed.all { "tasks:$it" in keys || it in missingIds })
        return value
    }
    fun payload(type: String, value: JSONObject): JSONObject = when (type) {
        "tasks" -> GoalflowJson.taskPayload(GoalflowJson.parseTask(value.toString(), strict = true))
        "daily_plans" -> JSONObject().put("localDate", value.getString("localDate"))
            .put("confirmedAt", value.getLong("confirmedAt")).put("taskIds", value.getJSONArray("taskIds"))
        "progress" -> JSONObject(value.toString())
        else -> error("Invalid planning entity.")
    }
    private fun order(value: Any?) {
        require(value is JSONArray && value.length() <= 10000)
        val ids = (0 until value.length()).map { value.get(it).also { id -> require(id is String && id.length in 1..240) } }
        require(ids.toSet().size == ids.size)
    }
    fun policy(accountId: String, localDate: String, value: JSONObject): JSONObject {
        require(value.keys().asSequence().toSet() == setOf("schemaVersion", "accountId", "localDate", "revision", "confirmedOrder", "acceptedReplans", "history"))
        require(value.opt("schemaVersion") == 1 && value.opt("accountId") == accountId && value.opt("localDate") == localDate && ActionJson.day(localDate))
        require(value.isNull("revision") || value.opt("revision") is String)
        require((ActionJson.integer(value.opt("acceptedReplans")) ?: -1) >= 0)
        order(value.opt("confirmedOrder"))
        val history = value.getJSONArray("history"); val identities = mutableSetOf<String>()
        for (i in 0 until history.length()) {
            val receipt = history.getJSONObject(i)
            require(receipt.keys().asSequence().toSet() == setOf("command", "code", "revision", "acceptedReplans", "actualDebit", "requiredCost", "order"))
            val command = receipt.getJSONObject("command"); DeliberatePlanning.validate(command)
            require(command.opt("accountId") == accountId && command.opt("localDate") == localDate && identities.add(command.getString("operationId")))
            val code = receipt.getString("code"); require(code in setOf("APPLIED", "STALE_REVISION", "COST_CHANGED"))
            val cost = ActionJson.integer(receipt.opt("requiredCost")) ?: error("Invalid planning cost.")
            val debit = ActionJson.integer(receipt.opt("actualDebit")) ?: error("Invalid planning debit.")
            require(cost in 0..50 && debit in 0..cost && (ActionJson.integer(receipt.opt("acceptedReplans")) ?: -1) >= 0)
            require(receipt.isNull("revision") || receipt.opt("revision") is String)
            require(if (code == "APPLIED") receipt.opt("revision") == command.opt("operationId") && cost <= command.getLong("maximumAcceptedXp") else debit == 0L)
            order(receipt.opt("order"))
        }
        if (history.length() > 0) {
            val last = history.getJSONObject(history.length() - 1)
            require(same(last.opt("revision"), value.opt("revision")) && same(last.opt("acceptedReplans"), value.opt("acceptedReplans")))
        }
        return value
    }
    fun day(accountId: String, localDate: String, response: JSONObject): JSONObject {
        val keys = response.keys().asSequence().toSet()
        val expected = setOf("schemaVersion", "accountId", "policy", "enforcementEnabled")
        require((keys == expected || keys == expected + "records") && response.opt("schemaVersion") == 1 && response.opt("accountId") == accountId && response.opt("enforcementEnabled") is Boolean)
        policy(accountId, localDate, response.getJSONObject("policy"))
        val records = if (response.has("records")) response.getJSONArray("records") else JSONArray()
        val seen = mutableSetOf<String>()
        for (i in 0 until records.length()) {
            val record = records.getJSONObject(i); val type = record.getString("entity_type"); val id = record.getString("entity_id")
            require(record.opt("user_id") == accountId && id.isNotEmpty() && type in setOf("tasks", "daily_plans", "progress") && seen.add("$type:$id"))
            require((ActionJson.integer(record.opt("server_version")) ?: 0) > 0 && (ActionJson.integer(record.opt("version")) ?: 0) > 0)
            require(record.getString("device_id").isNotEmpty() && record.has("deleted_at") && (record.isNull("deleted_at") || record.opt("deleted_at") is String))
            Instant.parse(record.getString("updated_at"))
            val payload = record.getJSONObject("payload")
            when (type) {
                "daily_plans" -> require(id == localDate)
                "progress" -> require(id == "singleton")
                "tasks" -> require(payload.opt("id") == id && (if (payload.has("scheduledFor") && !payload.isNull("scheduledFor")) payload.opt("scheduledFor") else payload.opt("dateAssigned")) == localDate)
            }
        }
        return response
    }
    fun response(accountId: String, command: JSONObject, response: JSONObject): JSONObject {
        DeliberatePlanning.validate(command)
        require(command.opt("accountId") == accountId && response.opt("schemaVersion") == 1 && response.opt("accountId") == accountId)
        val receipt = response.getJSONObject("receipt"); val policy = response.getJSONObject("policy")
        require(same(receipt.opt("command"), command) && policy.opt("schemaVersion") == 1 && policy.opt("accountId") == accountId
            && policy.opt("localDate") == command.opt("localDate") && same(policy.opt("revision"), receipt.opt("revision"))
            && policy.opt("acceptedReplans") == receipt.opt("acceptedReplans")) { "Planning response scope differs." }
        policy(accountId, command.getString("localDate"), policy)
        val history = policy.getJSONArray("history")
        require(history.length() > 0 && same(history.getJSONObject(history.length() - 1), receipt)) { "Planning receipt is absent from history." }
        val code = receipt.getString("code"); require(code in setOf("APPLIED", "STALE_REVISION", "COST_CHANGED"))
        val debit = ActionJson.integer(receipt.opt("actualDebit")) ?: error("Invalid planning debit.")
        val cost = ActionJson.integer(receipt.opt("requiredCost")) ?: error("Invalid planning cost.")
        require(debit in 0..cost && cost in 0..50 && (code == "APPLIED" || debit == 0L))
        val records = response.getJSONArray("records")
        if (code != "APPLIED") { require(records.length() == 0); return response }
        require(receipt.opt("revision") == command.opt("operationId") && cost <= command.getLong("maximumAcceptedXp")
            && same(policy.opt("confirmedOrder"), receipt.opt("order")))
        val order = receipt.getJSONArray("order"); val ids = (0 until order.length()).map(order::getString)
        require(ids.toSet().size == ids.size && records.length() == ids.size + 2)
        val keys = mutableSetOf<String>()
        for (i in 0 until records.length()) {
            val record = records.getJSONObject(i); val type = record.getString("entity_type"); val entityId = record.getString("entity_id")
            require(record.opt("user_id") == accountId && type in setOf("tasks", "progress", "daily_plans")
                && keys.add("$type:$entityId") && record.has("deleted_at") && record.isNull("deleted_at")
                && (ActionJson.integer(record.opt("server_version")) ?: 0) > 0 && (ActionJson.integer(record.opt("version")) ?: 0) > 0)
            Instant.parse(record.getString("updated_at")); require(record.getString("device_id").isNotEmpty())
            val value = record.getJSONObject("payload")
            when (type) {
                "tasks" -> require(value.opt("id") == entityId && entityId in ids && value.getInt("plannedOrder") == ids.indexOf(entityId)
                    && value.opt("completed") != true && value.optString("lifecycleStatus", "open") == "open")
                "progress" -> require(entityId == "singleton" && (ActionJson.integer(value.opt("xp")) ?: -1) >= 0)
                "daily_plans" -> require(entityId == command.getString("localDate") && same(value.opt("taskIds"), order))
            }
        }
        require(keys.contains("progress:singleton") && keys.contains("daily_plans:${command.getString("localDate")}") && ids.all { keys.contains("tasks:$it") })
        return response
    }
}
