import Foundation

struct ParsedCapture: Equatable {
    var cleanTitle: String
    var durationMinutes: Int? // 1..1440 clamped if present
    var tags: [String]
    var urls: [String]
    var scheduledFor: String? // YYYY-MM-DD or YYYY-MM
    var schedulePrecision: SchedulePrecision?
    var scheduledTime: String? // HH:mm
    var isFrog: Bool
    var isQuickie: Bool
    var notes: String?
}

enum CaptureParser {
    static func parse(raw: String, today: String? = nil) -> ParsedCapture {
        var s = raw
        var duration: Int?
        var isFrog = false
        var isQuickie = false
        var tags: [String] = []
        var urls: [String] = []
        var scheduledFor: String?
        var precision: SchedulePrecision?
        var scheduledTime: String?

        let todayStr = today ?? makeTodayString()

        // 1. Frog: *f or *frog
        if let r = try? NSRegularExpression(pattern: #"\*f(rog)?\b"#, options: .caseInsensitive) {
            let range = NSRange(s.startIndex..., in: s)
            if r.firstMatch(in: s, range: range) != nil {
                isFrog = true
                s = r.stringByReplacingMatches(in: s, range: range, withTemplate: "")
            }
        }

        // 2. Quickie: @quick or @quickie -> 2 min
        if let r = try? NSRegularExpression(pattern: #"@quick(ie)?\b"#, options: .caseInsensitive) {
            let range = NSRange(s.startIndex..., in: s)
            if r.firstMatch(in: s, range: range) != nil {
                isQuickie = true
                duration = 2
                s = r.stringByReplacingMatches(in: s, range: range, withTemplate: "")
            }
        }

        // 3. URLs first (so they are not confused with hashtags)
        if let r = try? NSRegularExpression(pattern: #"https?://\S+"#) {
            let range = NSRange(s.startIndex..., in: s)
            let matches = r.matches(in: s, range: range)
            for m in matches.reversed() {
                if let rng = Range(m.range, in: s) {
                    urls.append(String(s[rng]))
                }
            }
            // remove from s but keep for notes later
            s = r.stringByReplacingMatches(in: s, range: range, withTemplate: "")
        }

        // 4. Duration @(\d+)(m|min|mins|h|hr|hrs) — accumulative
        if let r = try? NSRegularExpression(pattern: #"@(\d+)(m|min|mins|h|hr|hrs)\b"#, options: .caseInsensitive) {
            let range = NSRange(s.startIndex..., in: s)
            let matches = r.matches(in: s, range: range)
            for m in matches {
                if m.numberOfRanges >= 3,
                   let vRange = Range(m.range(at: 1), in: s),
                   let uRange = Range(m.range(at: 2), in: s) {
                    let num = Int(s[vRange]) ?? 0
                    let unit = String(s[uRange]).lowercased()
                    if unit.hasPrefix("h") { duration = (duration ?? 0) + num * 60 }
                    else {
                        duration = (duration ?? 0) + num
                        if (duration ?? 0) <= 2 && !isQuickie { isQuickie = true }
                    }
                }
            }
            s = r.stringByReplacingMatches(in: s, range: range, withTemplate: "")
        }

        // 4b natural language: (?:for )?(\d+)\s*(min|mins|minute|minutes|h|hr|hrs|hour|hours)\b
        if let r = try? NSRegularExpression(pattern: #"\b(?:for )?(\d+)\s*(min|mins|minute|minutes|h|hr|hrs|hour|hours)\b"#, options: .caseInsensitive) {
            let range = NSRange(s.startIndex..., in: s)
            let matches = r.matches(in: s, range: range)
            for m in matches {
                if m.numberOfRanges >= 3,
                   let vRange = Range(m.range(at: 1), in: s),
                   let uRange = Range(m.range(at: 2), in: s) {
                    let num = Int(s[vRange]) ?? 0
                    let unit = String(s[uRange]).lowercased()
                    if unit.hasPrefix("h") { duration = (duration ?? 0) + num * 60 }
                    else {
                        duration = (duration ?? 0) + num
                        if (duration ?? 0) <= 2 && !isQuickie { isQuickie = true }
                    }
                }
            }
            s = r.stringByReplacingMatches(in: s, range: range, withTemplate: "")
        }

        // 4c adjective: (\d+)-(minute|min|hour|hr)\b
        if let r = try? NSRegularExpression(pattern: #"\b(\d+)-(?:minute|min|hour|hr)\b"#, options: .caseInsensitive) {
            let range = NSRange(s.startIndex..., in: s)
            let matches = r.matches(in: s, range: range)
            for m in matches {
                if let vRange = Range(m.range(at: 1), in: s) {
                    let num = Int(s[vRange]) ?? 0
                    // check if match contains h
                    let full = (s as NSString).substring(with: m.range)
                    if full.lowercased().contains("h") { duration = (duration ?? 0) + num * 60 }
                    else {
                        duration = (duration ?? 0) + num
                        if (duration ?? 0) <= 2 && !isQuickie { isQuickie = true }
                    }
                }
            }
            s = r.stringByReplacingMatches(in: s, range: range, withTemplate: "")
        }

        // 4d bare short duration without @ : \b(\d+)(m|min|mins|h|hr|hrs)\b — handles "@1h 15m" style
        if let r = try? NSRegularExpression(pattern: #"\b(\d+)(m|min|mins|h|hr|hrs)\b"#, options: .caseInsensitive) {
            let range = NSRange(s.startIndex..., in: s)
            let matches = r.matches(in: s, range: range)
            for m in matches {
                if m.numberOfRanges >= 3,
                   let vRange = Range(m.range(at: 1), in: s),
                   let uRange = Range(m.range(at: 2), in: s) {
                    let num = Int(s[vRange]) ?? 0
                    let unit = String(s[uRange]).lowercased()
                    if unit.hasPrefix("h") { duration = (duration ?? 0) + num * 60 }
                    else {
                        duration = (duration ?? 0) + num
                        if (duration ?? 0) <= 2 && !isQuickie { isQuickie = true }
                    }
                }
            }
            if !matches.isEmpty {
                s = r.stringByReplacingMatches(in: s, range: range, withTemplate: "")
            }
        }

        // clamp duration
        if let d = duration { duration = max(1, min(1440, d)) }

        // 5. Hashtags #tag
        if let r = try? NSRegularExpression(pattern: #"#([a-zA-Z0-9_]+)\b"#) {
            let range = NSRange(s.startIndex..., in: s)
            let matches = r.matches(in: s, range: range)
            for m in matches {
                if let tagRange = Range(m.range(at: 1), in: s) {
                    tags.append(String(s[tagRange]))
                }
            }
            s = r.stringByReplacingMatches(in: s, range: range, withTemplate: "")
        }

        // 6. scheduledTime HH:mm (standalone) — capture first valid
        if let r = try? NSRegularExpression(pattern: #"\b([01]\d|2[0-3]):([0-5]\d)\b"#) {
            let range = NSRange(s.startIndex..., in: s)
            if let m = r.firstMatch(in: s, range: range), let rng = Range(m.range, in: s) {
                scheduledTime = String(s[rng])
                s = r.stringByReplacingMatches(in: s, range: range, withTemplate: "")
                // only keep first
                // remove remaining times? we removed all via replacement above, but keep first as scheduledTime already
                // ensure only first kept - second one stripped anyway
            }
        }

        // 7. Dates: YYYY-MM-DD first then YYYY-MM
        // We search original remaining s for day pattern
        if let rDay = try? NSRegularExpression(pattern: #"\b(\d{4})-(\d{2})-(\d{2})\b"#) {
            let range = NSRange(s.startIndex..., in: s)
            if let m = rDay.firstMatch(in: s, range: range), let rng = Range(m.range, in: s) {
                let cand = String(s[rng])
                if isRealDay(cand) {
                    scheduledFor = cand
                    precision = .day
                    s = rDay.stringByReplacingMatches(in: s, range: range, withTemplate: "")
                }
            }
        }
        // If no day, try month
        if scheduledFor == nil, let rMonth = try? NSRegularExpression(pattern: #"\b(\d{4})-(\d{2})\b"#) {
            let range = NSRange(s.startIndex..., in: s)
            if let m = rMonth.firstMatch(in: s, range: range), let rng = Range(m.range, in: s) {
                let cand = String(s[rng])
                if isRealMonth(cand) {
                    // validate future month > monthOf(today)
                    if cand > String(todayStr.prefix(7)) {
                        scheduledFor = cand
                        precision = .month
                    } else {
                        // current/past month invalid as month precision — do not assign, let flow fallback to Select date
                        // leave cand in title? better strip but not assign
                        // we keep it stripped to avoid title noise, but not assign
                        // decide: keep stripped, not assign -> user will see Select date
                        // we strip to avoid title pollution
                    }
                    s = rMonth.stringByReplacingMatches(in: s, range: range, withTemplate: "")
                }
            }
        }

        // If scheduledFor is day and scheduledTime exists, fine; if month and scheduledTime exists, drop scheduledTime (invalid per assertSchedule)
        if precision == .month { scheduledTime = nil }

        // Collapse whitespace
        if let ws = try? NSRegularExpression(pattern: #"\s+"#) {
            s = ws.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: " ")
        }
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)

        return ParsedCapture(
            cleanTitle: s,
            durationMinutes: duration,
            tags: tags,
            urls: urls,
            scheduledFor: scheduledFor,
            schedulePrecision: precision,
            scheduledTime: scheduledTime,
            isFrog: isFrog,
            isQuickie: isQuickie,
            notes: nil
        )
    }
}
