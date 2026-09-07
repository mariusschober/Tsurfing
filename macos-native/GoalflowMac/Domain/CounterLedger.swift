import Foundation
import CoreFoundation

/// Shared JSON validation for newly captured causal actions. Legacy transport
/// payloads and their original timestamp precision are not rewritten here.
enum ActionJSON {
    static let maxSafeInteger = 9_007_199_254_740_991
    static func identity(_ value: Any?) -> Bool {
        guard let value = value as? String else { return false }
        return value.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil
    }
    static func integer(_ value: Any?) -> Int? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue.isFinite, abs(value.doubleValue) <= Double(maxSafeInteger),
              value.doubleValue.rounded(.towardZero) == value.doubleValue else { return nil }
        return value.intValue
    }
    static func instant(_ value: Any?) -> Bool {
        guard let value = value as? String,
              value.range(of: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$", options: .regularExpression) != nil else { return false }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: value) else { return false }
        return formatter.string(from: date) == value
    }
    static func day(_ value: Any?) -> Bool {
        guard let value = value as? String,
              value.range(of: "^\\d{4}-\\d{2}-\\d{2}$", options: .regularExpression) != nil else { return false }
        return instant(value + "T00:00:00.000Z")
    }
}

struct CounterLedgerError: Error {
    let code: String
}

/// The transaction establishes the baseline and authorizes correction evidence.
/// This function only projects distinct deltas; snapshots cannot mint events.
enum CounterLedger {
    static func project(baseline: [String: Any], events: [Any]) throws -> [String: Any] {
        func failure(_ code: String) -> CounterLedgerError { CounterLedgerError(code: code) }
        guard ActionJSON.integer(baseline["schemaVersion"]) == 1,
              ActionJSON.identity(baseline["baselineId"]), ActionJSON.identity(baseline["accountId"]),
              ActionJSON.day(baseline["day"]), let counts = baseline["counts"] as? [String: Any],
              let plans = ActionJSON.integer(counts["planViewCount"]), plans >= 0,
              let postpones = ActionJSON.integer(counts["dailyPostponeCount"]), postpones >= 0,
              let evidence = baseline["evidenceIds"] as? [String],
              evidence.allSatisfy({ ActionJSON.identity($0) }), Set(evidence).count == evidence.count else { throw failure("INVALID_BASELINE") }
        var totals = ["planViewCount": Decimal(plans), "dailyPostponeCount": Decimal(postpones)]
        var seen: [String: String] = [:]
        for raw in events {
            guard let event = raw as? [String: Any], ActionJSON.integer(event["schemaVersion"]) == 1,
                  ActionJSON.identity(event["actionId"]), ActionJSON.identity(event["accountId"]),
                  let actor = event["actorId"] as? String, (1...240).contains(actor.utf16.count),
                  ActionJSON.day(event["day"]), let zone = event["timeZone"] as? String,
                  zone.range(of: "^[A-Za-z0-9_+./-]{1,128}$", options: .regularExpression) != nil,
                  let counter = event["counter"] as? String, totals[counter] != nil,
                  let delta = ActionJSON.integer(event["delta"]), delta != 0,
                  ActionJSON.instant(event["capturedAt"]),
                  event["businessActionId"] is NSNull || ActionJSON.identity(event["businessActionId"]),
                  (event["correctionOf"] is NSNull ? delta == 1 : ActionJSON.identity(event["correctionOf"])) else { throw failure("INVALID_DELTA") }
            guard event["accountId"] as? String == baseline["accountId"] as? String else { throw failure("SCOPE_MISMATCH") }
            let actionID = event["actionId"] as! String
            if evidence.contains(actionID) { throw failure("IDENTITY_MISMATCH") }
            let fingerprint = stableJson(event)
            if let previous = seen[actionID] {
                guard previous == fingerprint else { throw failure("IDENTITY_MISMATCH") }
                continue
            }
            seen[actionID] = fingerprint
            if event["day"] as? String != baseline["day"] as? String { continue }
            totals[counter]! += Decimal(delta)
        }
        var projection = counts
        for (counter, total) in totals {
            guard !total.isNaN, total >= 0, total <= Decimal(ActionJSON.maxSafeInteger) else { throw failure("RANGE") }
            projection[counter] = NSDecimalNumber(decimal: total).intValue
        }
        return projection
    }
}
