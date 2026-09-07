import XCTest
@testable import GoalflowMac

// MARK: - SchedulingBridge

final class SchedulingBridgeTests: XCTestCase {
    func test_assertSchedule_day_valid() throws {
        try assertSchedule(precision: .day, scheduledFor: "2026-09-01", today: "2026-09-01", scheduledTime: nil)
        try assertSchedule(precision: .day, scheduledFor: "2026-09-01", today: "2026-09-01", scheduledTime: "14:30")
    }
    func test_assertSchedule_day_invalid() {
        XCTAssertThrowsError(try assertSchedule(precision: .day, scheduledFor: "2026-13-01", today: "2026-09-01", scheduledTime: nil)) { e in
            XCTAssertEqual((e as? SchedulingError)?.code, .invalidDay)
        }
        XCTAssertThrowsError(try assertSchedule(precision: .day, scheduledFor: "2026-02-30", today: "2026-09-01", scheduledTime: nil)) { e in
            XCTAssertEqual((e as? SchedulingError)?.code, .invalidDay)
        }
    }
    func test_assertSchedule_month_future_valid() throws {
        try assertSchedule(precision: .month, scheduledFor: "2026-10", today: "2026-09-01", scheduledTime: nil)
    }
    func test_assertSchedule_month_current_requires_day() {
        XCTAssertThrowsError(try assertSchedule(precision: .month, scheduledFor: "2026-09", today: "2026-09-01", scheduledTime: nil)) { e in
            XCTAssertEqual((e as? SchedulingError)?.code, .currentMonthRequiresDay)
        }
        XCTAssertThrowsError(try assertSchedule(precision: .month, scheduledFor: "2026-08", today: "2026-09-01", scheduledTime: nil)) { e in
            XCTAssertEqual((e as? SchedulingError)?.code, .currentMonthRequiresDay)
        }
    }
    func test_assertSchedule_month_invalid_time() {
        XCTAssertThrowsError(try assertSchedule(precision: .month, scheduledFor: "2026-10", today: "2026-09-01", scheduledTime: "10:00")) { e in
            XCTAssertEqual((e as? SchedulingError)?.code, .invalidTime)
        }
    }
    func test_assertSchedule_time_format_invalid() {
        XCTAssertThrowsError(try assertSchedule(precision: .day, scheduledFor: "2026-09-01", today: "2026-09-01", scheduledTime: "24:00")) { e in
            XCTAssertEqual((e as? SchedulingError)?.code, .invalidTime)
        }
    }
    func test_isRealDay_andMonth() {
        XCTAssertTrue(isRealDay("2026-09-01"))
        XCTAssertFalse(isRealDay("2026-02-30"))
        XCTAssertFalse(isRealDay("2026-13-01"))
        XCTAssertTrue(isRealMonth("2026-12"))
        XCTAssertFalse(isRealMonth("2026-13"))
        XCTAssertFalse(isRealMonth("2026-00"))
        XCTAssertEqual(monthOf("2026-09-15"), "2026-09")
    }
}

// MARK: - CaptureParser

final class CaptureParserTests: XCTestCase {
    func test_duration_m() {
        let p = CaptureParser.parse(raw: "Draft report @25m", today: "2026-09-01")
        XCTAssertEqual(p.durationMinutes, 25)
        XCTAssertEqual(p.cleanTitle, "Draft report")
    }
    func test_duration_h_combo() {
        let p = CaptureParser.parse(raw: "Write @1h 15m", today: "2026-09-01")
        XCTAssertEqual(p.durationMinutes, 75)
    }
    func test_duration_natural_language() {
        let p = CaptureParser.parse(raw: "Research for 2 hours", today: "2026-09-01")
        XCTAssertEqual(p.durationMinutes, 120)
    }
    func test_hashtag_extraction() {
        let p = CaptureParser.parse(raw: "Fix bug #focus #deep", today: "2026-09-01")
        XCTAssertEqual(p.tags, ["focus","deep"])
        XCTAssertEqual(p.cleanTitle, "Fix bug")
    }
    func test_url_extraction() {
        let p = CaptureParser.parse(raw: "Check design https://example.com/page extra", today: "2026-09-01")
        XCTAssertEqual(p.urls, ["https://example.com/page"])
        XCTAssertEqual(p.cleanTitle, "Check design extra")
    }
    func test_frog_and_quickie() {
        let f = CaptureParser.parse(raw: "Eat frog *f @15m", today: "2026-09-01")
        XCTAssertTrue(f.isFrog)
        let q = CaptureParser.parse(raw: "Quick note @quick", today: "2026-09-01")
        XCTAssertTrue(q.isQuickie); XCTAssertEqual(q.durationMinutes, 2)
        let q2 = CaptureParser.parse(raw: "Tiny @2m", today: "2026-09-01")
        XCTAssertTrue(q2.isQuickie)
    }
    func test_date_day() {
        let p = CaptureParser.parse(raw: "Plan Q4 2026-09-15 @30m", today: "2026-09-01")
        XCTAssertEqual(p.scheduledFor, "2026-09-15")
        XCTAssertEqual(p.schedulePrecision, .day)
        XCTAssertEqual(p.cleanTitle, "Plan Q4")
    }
    func test_date_month_future() {
        let p = CaptureParser.parse(raw: "Idea for later 2026-11", today: "2026-09-01")
        XCTAssertEqual(p.scheduledFor, "2026-11")
        XCTAssertEqual(p.schedulePrecision, .month)
        XCTAssertNil(p.scheduledTime)
    }
    func test_date_month_current_not_assigned() {
        // current month as month precision should not assign (needs day)
        let p = CaptureParser.parse(raw: "Oops 2026-09", today: "2026-09-01")
        XCTAssertNil(p.scheduledFor)
        XCTAssertNil(p.schedulePrecision)
    }
    func test_scheduledTime() {
        let p = CaptureParser.parse(raw: "Meeting 2026-09-01 14:30 @60m", today: "2026-09-01")
        XCTAssertEqual(p.scheduledTime, "14:30")
        XCTAssertEqual(p.scheduledFor, "2026-09-01")
    }
    func test_month_with_time_drops_time() {
        let p = CaptureParser.parse(raw: "Future 2026-11 09:00", today: "2026-09-01")
        XCTAssertEqual(p.scheduledFor, "2026-11")
        XCTAssertNil(p.scheduledTime)
    }
    func test_cleanTitle_collapse() {
        let p = CaptureParser.parse(raw: "  Draft   report  @25m   #tag  https://x.com  2026-09-01  ", today: "2026-09-01")
        XCTAssertEqual(p.cleanTitle, "Draft report")
        XCTAssertEqual(p.tags, ["tag"])
        XCTAssertEqual(p.urls, ["https://x.com"])
        XCTAssertEqual(p.durationMinutes, 25)
        XCTAssertEqual(p.scheduledFor, "2026-09-01")
    }
    func test_title_empty_results_in_empty_clean() {
        let p = CaptureParser.parse(raw: "@25m #tag 2026-09-01", today: "2026-09-01")
        XCTAssertEqual(p.cleanTitle, "")
        XCTAssertEqual(p.durationMinutes, 25)
    }
}

final class NaturalCaptureScheduleTests: XCTestCase {
    func testCalendarPhrases() {
        let cases: [(String, String, String, String, String)] = [
            ("2026-09-07", "Send report today", "2026-09-07", "day", "Send report"),
            ("2026-12-31", "Send report tomorrow", "2027-01-01", "day", "Send report"),
            ("2026-09-07", "Send report next week", "2026-09-14", "day", "Send report"),
            ("2026-12-31", "Send report next month", "2027-01", "month", "Send report"),
            ("2026-08-31", "Send report September", "2026-09", "month", "Send report"),
            ("2026-09-07", "Send report September", "2027-09", "month", "Send report"),
            ("2026-12-20", "Send report in 3 weeks", "2027-01-10", "day", "Send report"),
            ("2028-02-26", "Send report in 4 days", "2028-03-01", "day", "Send report"),
            ("2026-01-31", "Send report in 3 months", "2026-04", "month", "Send report"),
            ("2026-09-07", "Tomorrow send report", "2026-09-08", "day", "send report"),
            ("2026-09-07", "Send report Friday", "2026-09-11", "day", "Send report"),
            ("2026-09-07", "Send report in May", "2027-05", "month", "Send report")
        ]
        for (today, title, date, precision, clean) in cases {
            let result = CaptureParser.parse(raw: title, today: today)
            XCTAssertEqual(result.scheduledFor, date, title)
            XCTAssertEqual(result.schedulePrecision, precision == "month" ? .month : .day, title)
            XCTAssertEqual(result.cleanTitle, clean, title)
        }
    }
    func testOrdinaryWordsRemainTitleText() {
        for title in ["We may review", "march forward", "Review months of notes", "Review in 0 days"] {
            let result = CaptureParser.parse(raw: title, today: "2026-09-07")
            XCTAssertNil(result.scheduledFor)
            XCTAssertEqual(result.cleanTitle, title)
        }
    }
}
