import Foundation
import EventKit

struct CalendarCollision: Equatable, Sendable {
    var eventTitle: String
    var start: Date
    var end: Date
}

protocol CalendarCollisionService: Sendable {
    func collision(for task: GoalflowTask, today: String) async -> CalendarCollision?
    func requestAccessIfNeeded() async -> Bool
}

final class NoopCalendarService: CalendarCollisionService, Sendable {
    func collision(for task: GoalflowTask, today: String) async -> CalendarCollision? { nil }
    func requestAccessIfNeeded() async -> Bool { false }
}

final class EKCalendarCollisionService: CalendarCollisionService, @unchecked Sendable {
    private let store = EKEventStore()

    func requestAccessIfNeeded() async -> Bool {
        let status = EKEventStore.authorizationStatus(for: .event)
        switch status {
        case .authorized, .fullAccess: return true
        case .notDetermined:
            if #available(macOS 14.0, *) {
                do { return try await store.requestFullAccessToEvents() } catch { return false }
            } else {
                do { return try await store.requestAccess(to: .event) } catch { return false }
            }
        default: return false
        }
    }

    func collision(for task: GoalflowTask, today: String) async -> CalendarCollision? {
        guard let time = task.scheduledTime, task.schedulePrecision == .day, task.scheduledFor == today else { return nil }
        // Parse today + time to Date
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        formatter.timeZone = .current
        formatter.locale = Locale(identifier: "en_US_POSIX")
        guard let start = formatter.date(from: "\(today) \(time)") else { return nil }
        let duration = task.durationMinutes
        guard let end = Calendar.current.date(byAdding: .minute, value: duration, to: start) else { return nil }
        let status = EKEventStore.authorizationStatus(for: .event)
        guard status == .authorized || status == .fullAccess else { return nil }
        // Query events for the day
        let dayStart = Calendar.current.startOfDay(for: start)
        guard let dayEnd = Calendar.current.date(byAdding: .day, value: 1, to: dayStart) else { return nil }
        let predicate = store.predicateForEvents(withStart: dayStart, end: dayEnd, calendars: nil)
        let events = store.events(matching: predicate)
        for ev in events {
            if ev.isAllDay { continue }
            guard let s = ev.startDate, let e = ev.endDate else { continue }
            if s < end && e > start {
                return CalendarCollision(eventTitle: ev.title ?? "Calendar event", start: s, end: e)
            }
        }
        return nil
    }
}
