import Foundation

enum SchedulingErrorCode: String, Equatable {
    case invalidTitle = "invalid_title"
    case invalidDay = "invalid_day"
    case invalidMonth = "invalid_month"
    case currentMonthRequiresDay = "current_month_requires_day"
    case invalidTime = "invalid_time"
}

struct SchedulingError: Error, Equatable {
    let code: SchedulingErrorCode
    let message: String
}

// MARK: - Patterns

private let dayPattern = try! NSRegularExpression(pattern: #"^\d{4}-\d{2}-\d{2}$"#)
private let monthPattern = try! NSRegularExpression(pattern: #"^\d{4}-\d{2}$"#)
private let timePattern = try! NSRegularExpression(pattern: #"^(?:[01]\d|2[0-3]):[0-5]\d$"#)

private func matches(_ regex: NSRegularExpression, _ s: String) -> Bool {
    let r = NSRange(s.startIndex..., in: s)
    return regex.firstMatch(in: s, range: r) != nil
}

func isRealDay(_ value: String) -> Bool {
    guard matches(dayPattern, value) else { return false }
    let parts = value.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3, parts[0] >= 1 else { return false }
    var comps = DateComponents()
    comps.year = parts[0]; comps.month = parts[1]; comps.day = parts[2]
    comps.timeZone = TimeZone(identifier: "UTC")
    let cal = Calendar(identifier: .gregorian)
    guard let date = cal.date(from: comps) else { return false }
    let dc = cal.dateComponents(in: TimeZone(identifier: "UTC") ?? .current, from: date)
    return dc.year == parts[0] && dc.month == parts[1] && dc.day == parts[2]
}

func isRealMonth(_ value: String) -> Bool {
    guard matches(monthPattern, value) else { return false }
    let year = Int(value.prefix(4)) ?? 0
    guard year >= 1 else { return false }
    let monthStr = String(value.suffix(2))
    guard let m = Int(monthStr) else { return false }
    return (1...12).contains(m)
}

func monthOf(_ localDate: String) -> String { String(localDate.prefix(7)) }

func assertSchedule(precision: SchedulePrecision, scheduledFor: String, today: String, scheduledTime: String?) throws {
    guard isRealDay(today) else {
        throw SchedulingError(code: .invalidDay, message: "The scheduling context needs a valid local day.")
    }
    if let t = scheduledTime, !matches(timePattern, t) {
        throw SchedulingError(code: .invalidTime, message: "Time must use the 24-hour HH:mm format.")
    }
    if precision == .day {
        guard isRealDay(scheduledFor) else {
            throw SchedulingError(code: .invalidDay, message: "Choose a valid calendar day.")
        }
        return
    }
    // month
    guard isRealMonth(scheduledFor) else {
        throw SchedulingError(code: .invalidMonth, message: "Choose a valid calendar month.")
    }
    if scheduledFor <= monthOf(today) {
        throw SchedulingError(code: .currentMonthRequiresDay, message: "Tasks in the current or a past month need an exact day.")
    }
    if scheduledTime != nil {
        throw SchedulingError(code: .invalidTime, message: "A time can only be set for an exact day.")
    }
}

func makeTodayString(from date: Date = Date()) -> String {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.timeZone = .current
    f.locale = Locale(identifier: "en_US_POSIX")
    return f.string(from: date)
}
