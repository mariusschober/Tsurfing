import XCTest
@testable import GoalflowMac

final class CounterLedgerTests: XCTestCase {
    func testSharedCounterFixturesInEitherOrder() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("tests/fixtures/s2/counters-v1.json"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let baseline = try XCTUnwrap(fixture["baseline"] as? [String: Any])
        for scenario in try XCTUnwrap(fixture["cases"] as? [[String: Any]]) {
            let events = try XCTUnwrap(scenario["events"] as? [Any])
            for ordered in [events, Array(events.reversed())] {
                do {
                    let projection = try CounterLedger.project(baseline: baseline, events: ordered)
                    XCTAssertNil(scenario["error"], "Expected rejection: \(scenario["name"] ?? "")")
                    XCTAssertEqual(stableJson(projection), stableJson(scenario["expected"]), "\(scenario["name"] ?? "")")
                } catch let error as CounterLedgerError {
                    XCTAssertEqual(error.code, scenario["error"] as? String, "\(scenario["name"] ?? "")")
                }
            }
        }
    }
}
