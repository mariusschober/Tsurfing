package com.mariusschober.goalflow.nativeapp.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.mariusschober.goalflow.nativeapp.data.SyncConflictEntity
import org.json.JSONArray
import org.json.JSONObject

data class NativeConflictDifference(val label: String, val device: String, val cloud: String)
data class NativeConflictReview(
    val title: String,
    val summary: String,
    val differences: List<NativeConflictDifference>,
    val deviceChoice: String,
    val cloudChoice: String
)

private val conflictMetadata = setOf("id", "cloudId", "createdAt", "updatedAt", "version", "serverVersion", "deviceId")
private val conflictLabels = mapOf(
    "title" to "Title", "name" to "Name", "description" to "Notes", "notes" to "Notes",
    "duration" to "Duration", "scheduledFor" to "Scheduled day", "scheduledTime" to "Start time",
    "dateAssigned" to "Assigned day", "schedulePrecision" to "Schedule",
    "lifecycleStatus" to "Status", "completed" to "Completed", "wontDo" to "Dropped",
    "isFrog" to "Priority task", "beforeFrog" to "Before priority task", "plannedOrder" to "Order",
    "source" to "Capture source", "hashtags" to "Tags", "goalId" to "Goal"
)

private fun reviewJson(value: Any?): String = when (value) {
    null, JSONObject.NULL -> "null"
    is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(prefix = "{", postfix = "}") {
        "${JSONObject.quote(it)}:${reviewJson(value.opt(it))}"
    }
    is JSONArray -> (0 until value.length()).joinToString(prefix = "[", postfix = "]") { reviewJson(value.opt(it)) }
    is String -> JSONObject.quote(value)
    else -> value.toString()
}

private fun reviewValue(key: String, value: Any?): String = when (value) {
    null, JSONObject.NULL -> "Not set"
    is Boolean -> if (value) "Yes" else "No"
    is Number -> if (key == "duration") "$value min" else value.toString()
    is String -> value.ifBlank { "Empty" }
    is JSONArray -> (0 until value.length()).joinToString { reviewValue("", value.opt(it)) }.ifBlank { "None" }
    else -> reviewJson(value)
}.let { if (it.length > 500) it.take(500) + "… (more saved content)" else it }

/** Presentation only: this never merges records or changes the acknowledgment policy. */
fun nativeConflictReview(conflict: SyncConflictEntity): NativeConflictReview {
    val device = runCatching { JSONObject(conflict.localPayload) }.getOrNull()
    val cloud = runCatching { JSONObject(conflict.serverPayload) }.getOrNull()
    val missingCloud = conflict.serverPayload.isBlank()
    val deviceDeleted = conflict.localDeletedAt != null
    val cloudDeleted = conflict.serverDeletedAt != null
    val title = sequenceOf(device?.optString("title"), cloud?.optString("title"),
        device?.optString("name"), cloud?.optString("name"))
        .filterNotNull().firstOrNull { it.isNotBlank() }
        ?: conflict.entityType.removeSuffix("s").replace('_', ' ').replaceFirstChar { it.uppercase() }
    val fields = if (device != null && cloud != null) {
        (device.keys().asSequence().toSet() + cloud.keys().asSequence().toSet())
            .filterNot { it in conflictMetadata }
            .sorted()
            .filter { reviewJson(device.opt(it)) != reviewJson(cloud.opt(it)) }
            .map { key -> NativeConflictDifference(
                conflictLabels[key] ?: key.replace(Regex("([a-z])([A-Z])"), "$1 $2")
                    .replace('_', ' ').replaceFirstChar { it.uppercase() },
                reviewValue(key, device.opt(key)), reviewValue(key, cloud.opt(key))
            ) }
    } else emptyList()
    val matchingContents = device != null && cloud != null && fields.isEmpty()
    val stateDifference = if (deviceDeleted != cloudDeleted || missingCloud) listOf(
        NativeConflictDifference("Availability", if (deviceDeleted) "Deleted" else "Saved",
            if (missingCloud) "Not present in cloud" else if (cloudDeleted) "Deleted" else "Saved")
    ) else emptyList()
    val summary = when {
        missingCloud -> "The cloud no longer has this item. Keep the device copy or remove it from this device."
        device == null || cloud == null -> "This item cannot be fully compared here. Both versions remain saved; review its complete contents before choosing."
        deviceDeleted && cloudDeleted && matchingContents -> "Both copies are already deleted and their contents match. Only their saved history differs."
        deviceDeleted != cloudDeleted -> "One version was deleted while another was kept. Choose whether to keep the deletion or the saved version."
        matchingContents -> "The saved contents match. Only their saved history differs."
        else -> "These details differ. Each choice applies to this whole item, not just one field."
    }
    return NativeConflictReview(
        title = title,
        summary = summary,
        differences = stateDifference + fields,
        deviceChoice = if (deviceDeleted) "Keep device deletion" else "Keep device version",
        cloudChoice = if (missingCloud) "Remove device copy" else if (cloudDeleted) "Keep cloud deletion" else "Keep cloud version"
    )
}

@Composable
internal fun NativeConflictReviewDialog(
    conflict: SyncConflictEntity,
    onKeepDevice: (() -> Unit)?,
    onKeepCloud: () -> Unit,
    onLater: () -> Unit
) {
    val review = nativeConflictReview(conflict)
    AlertDialog(
        onDismissRequest = onLater,
        title = { Text("Review sync changes") },
        text = {
            Column(
                modifier = Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Text(review.title, style = MaterialTheme.typography.titleMedium)
                Text(review.summary)
                review.differences.forEach { difference ->
                    HorizontalDivider()
                    Text(difference.label, style = MaterialTheme.typography.labelLarge)
                    Text("On this device: ${difference.device}")
                    Text("In cloud: ${difference.cloud}")
                }
                Text("Review later keeps both versions and lets you continue using Tsurfing.",
                    style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onKeepCloud, modifier = Modifier.fillMaxWidth()) { Text(review.cloudChoice) }
                if (onKeepDevice != null) {
                    OutlinedButton(onClick = onKeepDevice, modifier = Modifier.fillMaxWidth()) { Text(review.deviceChoice) }
                }
                TextButton(onClick = onLater, modifier = Modifier.fillMaxWidth()) { Text("Review later") }
            }
        }
    )
}
