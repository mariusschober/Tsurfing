import Foundation

/// Causal action transport boundary. Mirrors the Web `causalTransport` +
/// `causalReceipts` checkpoints and Android `NativeCausalTransport`:
/// immutable wire bytes, byte-bounded requests/responses, exact receipt
/// validation, and durable archival that never retires on transport alone.
/// Epoch binding arrives with enrollment; the caller supplies the epoch.
enum CausalTransport {
    static let maxRequestBytes = 256 * 1024
    static let maxReceiptBytes = 8 * 1024 * 1024
    static let actionPath = "/api/v1/sync/actions"

    enum SendError: Error, LocalizedError {
        case oversizedRequest
        case oversizedResponse
        case retryable(String)
        case review(String)
        var errorDescription: String? {
            switch self {
            case .oversizedRequest: return "The saved action exceeds the transport envelope. It remains queued."
            case .oversizedResponse: return "The server receipt exceeds the transport envelope. Nothing was retired."
            case .retryable(let message): return message
            case .review(let message): return message
            }
        }
    }

    /// Canonical wire bytes for one version-2 operation. Unknown command
    /// fields participate in identity and are never normalized away.
    static func operationBytes(type: String, epoch: String, command: [String: Any]) throws -> Data {
        guard ["focus", "counter", "counterDay"].contains(type),
              UUID(uuidString: epoch) != nil else {
            throw SyncError.validation("The causal operation has no transportable identity. Nothing was sent.")
        }
        let operation: [String: Any] = ["schemaVersion": 2, "epoch": epoch, "type": type, "command": command]
        guard let body = stableJsonData(operation), !body.isEmpty else {
            throw SyncError.validation("The causal operation is not JSON. Nothing was sent.")
        }
        guard body.count <= maxRequestBytes else { throw SendError.oversizedRequest }
        return body
    }

    /// Sends saved bytes unchanged and returns the raw receipt body.
    /// HTTP failures distinguish retry from review without reflecting
    /// upstream diagnostics. Nothing is retired here.
    static func send(operation body: Data, via transport: SyncTransport) async throws -> Data {
        guard body.count <= maxRequestBytes else { throw SendError.oversizedRequest }
        let (data, response) = try await transport.request(path: actionPath, method: "POST", headers: [:], body: body)
        guard data.count <= maxReceiptBytes else { throw SendError.oversizedResponse }
        switch response.statusCode {
        case 200...299:
            return data
        case 408, 425, 429, 500...599:
            throw SendError.retryable("The server is temporarily unavailable. The exact saved action remains queued.")
        case 409:
            throw SendError.review("The server requires review of the saved action. It remains queued with its evidence.")
        default:
            throw SendError.review("The saved action was not accepted. It remains queued with its evidence.")
        }
    }
}

/// Exact version-2 receipt validation shared by every caller. Mirrors
/// `assertCausalReceipt` in `services/causalProtocol.ts`. Completion
/// receipts use the dedicated atomic validator in a later slice.
enum CausalReceiptValidator {
    private static func isFiniteTimestamp(_ value: String?) -> Bool {
        guard let value else { return false }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: value) { return date.timeIntervalSince1970.isFinite }
        return ISO8601DateFormatter().date(from: value).map { $0.timeIntervalSince1970.isFinite } ?? false
    }

    static func assert(operation: [String: Any], receipt: [String: Any], accountId: String) throws {
        func fail() throws -> Never {
            throw SyncError.validation("Synchronization did not prove the exact operation receipt. Nothing was retired.")
        }
        guard receipt["schemaVersion"] as? Int == 2,
              receipt["epoch"] as? String == operation["epoch"] as? String,
              let projectionRevision = ActionJSON.integer(receipt["projectionRevision"]), projectionRevision >= 1,
              stableJson(receipt["operation"]) == stableJson(operation),
              let accepted = receipt["accepted"] as? Bool,
              let record = receipt["record"] as? [String: Any],
              record["user_id"] as? String == accountId,
              record["entity_type"] as? String == "tracking",
              record["entity_id"] as? String == "singleton",
              let version = ActionJSON.integer(record["version"]), version >= 1,
              let serverVersion = ActionJSON.integer(record["server_version"]), serverVersion >= 1,
              let device = record["device_id"] as? String, !device.isEmpty,
              record["payload"] is [String: Any],
              isFiniteTimestamp(record["updated_at"] as? String),
              record["deleted_at"] is NSNull,
              let type = operation["type"] as? String,
              let command = operation["command"] as? [String: Any] else { try fail() }
        if type == "focus" {
            guard let outcome = receipt["outcome"] as? [String: Any],
                  outcome["accepted"] as? Bool == accepted,
                  let code = outcome["code"] as? String,
                  ["APPLIED", "STALE_TARGET", "STALE_REVISION", "TERMINAL", "INVALID_PHASE", "INVALID_RANGE", "SESSION_EXISTS"].contains(code),
                  accepted == (code == "APPLIED"),
                  outcome["revision"] is NSNull || ActionJSON.identity(outcome["revision"]),
                  !accepted || (outcome["revision"] as? String == command["actionId"] as? String) else { try fail() }
            if accepted {
                guard let payload = record["payload"] as? [String: Any],
                      let session = SharedFocusSessionRecord(dictionary: payload["focusSession"] as? [String: Any] ?? [:]),
                      session.sessionId == command["sessionId"] as? String,
                      session.taskId == command["taskId"] as? String,
                      ["active", "paused", "stopped"].contains(session.phase.rawValue) else { try fail() }
                if command["kind"] as? String == "stop" { guard session.phase == SharedFocusPhase.stopped else { try fail() } }
                if command["kind"] as? String == "pause" { guard session.phase == SharedFocusPhase.paused else { try fail() } }
            }
        } else if type == "counter" || type == "counterDay" {
            guard accepted else { try fail() }
            let counts: [String: Any]?
            if type == "counter" {
                guard let outcome = receipt["outcome"] as? [String: Any],
                      outcome["accepted"] as? Bool == true,
                      outcome["code"] as? String == "APPLIED",
                      outcome["day"] as? String == command["day"] as? String else { try fail() }
                counts = outcome["counts"] as? [String: Any]
            } else {
                counts = receipt["counts"] as? [String: Any]
            }
            guard let counts,
                  ActionJSON.integer(counts["planViewCount"]) != nil,
                  ActionJSON.integer(counts["dailyPostponeCount"]) != nil else { try fail() }
            if type == "counterDay" {
                guard let baseline = receipt["baseline"] as? [String: Any],
                      baseline["accountId"] as? String == accountId,
                      baseline["day"] as? String == command["day"] as? String else { try fail() }
            }
            if let payload = record["payload"] as? [String: Any],
               payload["date"] as? String == command["day"] as? String {
                guard payload["planViewCount"] as? Int == counts["planViewCount"] as? Int,
                      payload["dailyPostponeCount"] as? Int == counts["dailyPostponeCount"] as? Int else { try fail() }
            }
            if type == "counterDay", (command["kind"] as? String) == "select",
               (record["payload"] as? [String: Any])?["date"] as? String != command["day"] as? String { try fail() }
        } else {
            try fail()
        }
    }
}
