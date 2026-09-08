import Foundation

/// Deterministic JSON with sorted keys recursively, mirrors `stableJson` in `services/syncProtocol.ts:281`.
/// Uses JSONSerialization with .sortedKeys which recursively sorts dictionary keys.
func stableJson(_ value: Any?) -> String? {
    guard let v = value else { return "null" }
    // NSNull
    if v is NSNull { return "null" }
    // Data is already JSON?
    // Use JSONSerialization
    do {
        // Wrap non-JSON top-level (e.g., String/Number) via array trick? JSONSerialization requires top-level array/dict.
        // But our payloads are always objects/arrays. For String/Number/Bool we handle directly.
        if let s = v as? String { return try String(data: JSONSerialization.data(withJSONObject: [s], options: []), encoding: .utf8).map { String($0.dropFirst().dropLast()) } }
        if let b = v as? Bool { return b ? "true" : "false" }
        if let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() {
            // NSNumber
            return "\(n)"
        }
        // For Data already, try decode?
        let data = try JSONSerialization.data(withJSONObject: v, options: [.sortedKeys])
        return String(data: data, encoding: .utf8)
    } catch {
        return nil
    }
}

func stableJsonData(_ value: Any?) -> Data? {
    guard let s = stableJson(value) else { return nil }
    return s.data(using: .utf8)
}

// Convenience for Encodable
func stableJson<T: Encodable>(_ value: T) -> String? {
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys]
    enc.dateEncodingStrategy = .iso8601
    guard let data = try? enc.encode(value) else { return nil }
    return String(data: data, encoding: .utf8)
}

func sameInstant(_ a: String?, _ b: String?) -> Bool {
    guard let av = a, let bv = b else { return a == nil && b == nil }
    // Compare as ISO dates with tolerance? Use string equality after normalization
    // For sync, deletedAt is ISO string; compare directly or as dates
    if av == bv { return true }
    // Try parse as dates
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let da = f.date(from: av), let db = f.date(from: bv) { return abs(da.timeIntervalSince(db)) < 0.001 }
    // Fallback to second precision
    let f2 = ISO8601DateFormatter()
    if let da = f2.date(from: av), let db = f2.date(from: bv) { return abs(da.timeIntervalSince(db)) < 0.001 }
    return false
}

func finiteVersion(_ value: Any?) -> Int {
    if let n = value as? Int, n >= 0 { return n }
    if let n = value as? Double, n >= 0, n.truncatingRemainder(dividingBy: 1) == 0, n <= Double(Int.max) { return Int(n) }
    if let s = value as? String, let n = Int(s), n >= 0 { return n }
    return 0
}
func nullableVersion(_ value: Any?) -> Int? {
    if value == nil || value is NSNull { return nil }
    if let n = value as? Int, n >= 0 { return n }
    if let d = value as? Double, d >= 0, d.truncatingRemainder(dividingBy: 1) == 0 { return Int(d) }
    if let s = value as? String { if s.isEmpty { return nil }; if let n = Int(s), n >= 0 { return n } }
    return nil
}
