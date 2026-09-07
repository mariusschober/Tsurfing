import XCTest
@testable import GoalflowMac

final class CausalFocusTests: XCTestCase {
    func testInvalidBaselineRemainsInspectable() throws {
        let baseline = try XCTUnwrap(SharedFocusSessionRecord.start(taskId: "task-F", plannedDurationSeconds: 600)).toDictionary()
        var terminal = baseline
        terminal["phase"] = "completed"
        terminal["endedAt"] = baseline["startedAt"]
        terminal["pausedAt"] = baseline["startedAt"]
        var overflow = baseline
        overflow["elapsedSeconds"] = 9_007_199_254_740_992
        for malformed in [terminal, overflow] {
            let before = stableJson(malformed)
            XCTAssertThrowsError(try CausalFocus.initial(accountID: "11111111-1111-4111-8111-111111111111", baseline: malformed))
            XCTAssertEqual(before, stableJson(malformed))
        }
    }
    func testSharedCausalFocusFixtures() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("tests/fixtures/s2/focus-v1.json"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        for scenario in try XCTUnwrap(fixture["cases"] as? [[String: Any]]) {
            var journal = try CausalFocus.initial(accountID: fixture["accountId"] as! String)
            let commands = try XCTUnwrap(scenario["commands"] as? [[String: Any]])
            let codes = try XCTUnwrap(scenario["outcomeCodes"] as? [String])
            for (index, command) in commands.enumerated() {
                let before = stableJson(journal)
                let reply = try CausalFocus.apply(journal, command: command)
                XCTAssertEqual(before, stableJson(journal))
                XCTAssertEqual(reply.outcome["code"] as? String, codes[index], "\(scenario["name"] ?? "")")
                journal = reply.journal
            }
            let sessions = try XCTUnwrap(journal["sessions"] as? [String: [String: Any]])
            let actual = try XCTUnwrap(sessions[journal["currentSessionId"] as! String]?["projection"] as? [String: Any])
            for (key, value) in try XCTUnwrap(scenario["expected"] as? [String: Any]) {
                XCTAssertEqual(stableJson(actual[key]), stableJson(value), "\(scenario["name"] ?? ""):\(key)")
            }
            if scenario["name"] as? String == "completed-F-never-revives-after-G" {
                let previous = sessions["ffffffff-ffff-4fff-8fff-ffffffffffff"]?["projection"] as? [String: Any]
                XCTAssertEqual(previous?["phase"] as? String, "completed")
            }
        }
    }
}
