package com.mariusschober.goalflow.nativeapp.sync

import com.mariusschober.goalflow.nativeapp.data.ActionJson
import org.json.JSONObject
import org.json.JSONArray
import java.security.MessageDigest
import java.util.Base64

internal data class ReconciliationUpload(val manifest: JSONObject?, val chunks: List<JSONObject>) {
    companion object {
        private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }

        fun prepare(request: String): ReconciliationUpload {
            val bytes = request.toByteArray(Charsets.UTF_8)
            val count = JSONObject(request).getJSONArray("localHistory").length()
            if (bytes.size <= 262144 && count <= 1000) return ReconciliationUpload(null, emptyList())
            if (bytes.size > 4 * 1024 * 1024 || count > 100000) {
                throw NativeSyncProtocolException("Saved reconciliation exceeds the supported 4 MiB or 100,000-entry envelope. The full history remains preserved and needs larger-record recovery.")
            }
            val parts = (bytes.indices step 65536).map { offset -> bytes.copyOfRange(offset, minOf(offset + 65536, bytes.size)) }
            val hashes = parts.map(::hash)
            val manifest = JSONObject().put("schemaVersion", 1).put("sha256", hash(bytes))
                .put("totalBytes", bytes.size).put("chunkCount", parts.size).put("chunkHashes", JSONArray(hashes))
            val chunks = parts.mapIndexed { index, chunk ->
                JSONObject().put("manifest", manifest).put("chunkIndex", index)
                    .put("chunkSha256", hashes[index]).put("data", Base64.getEncoder().encodeToString(chunk))
            }
            return ReconciliationUpload(manifest, chunks)
        }

        fun verifyAck(chunk: JSONObject, response: String) {
            val ack = JSONObject(response)
            if (ack.opt("staged") != true || ack.opt("chunkIndex") != chunk.opt("chunkIndex")
                || ack.opt("chunkSha256") != chunk.opt("chunkSha256")
                || ActionJson.canonical(ack.opt("manifest")) != ActionJson.canonical(chunk.opt("manifest"))) {
                throw NativeSyncProtocolException("Reconciliation staging did not acknowledge the exact chunk. The full history remains saved.")
            }
        }
    }
}
