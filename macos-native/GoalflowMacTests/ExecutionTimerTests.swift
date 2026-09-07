import XCTest
import AVFoundation
@testable import GoalflowMac

final class ExecutionTimerTests: XCTestCase {
    func test_timer_derives_from_reference() {
        let start = Date(timeIntervalSince1970: 2_000_000)
        let state = ExecutionState(taskId: "t", phase: .active, startedAt: start, plannedDurationSeconds: 600)
        let clock = ManualClock(now: start.addingTimeInterval(20))
        // Use direct remaining calculation via ExecutionState, not the @MainActor timer
        XCTAssertEqual(state.remainingSeconds(now: clock.now()), 580)
        clock.advance(by: 40)
        XCTAssertEqual(state.remainingSeconds(now: clock.now()), 540)
    }

    func test_relaunch_within_1s_tolerance() {
        // Simulate kill and relaunch: saved start, new now
        let start = Date()
        let state = ExecutionState(taskId: "t", phase: .active, startedAt: start, plannedDurationSeconds: 1500)
        // 2 seconds later
        let now = start.addingTimeInterval(2.3)
        XCTAssertEqual(state.remainingSeconds(now: now), 1498) // floor
        // 47 seconds
        let later = start.addingTimeInterval(47.8)
        XCTAssertEqual(state.remainingSeconds(now: later), 1453)
    }
}

@MainActor
final class AudibleExecutionTimerTests: XCTestCase {
    func test_ticks_during_countdown_and_overtime_but_not_pause_or_repeated_time() {
        let clock = ManualClock(now: Date(timeIntervalSince1970: 2_000_000))
        let timer = ExecutionTimer(clock: clock)
        let state = ExecutionState(taskId: "task", phase: .active, startedAt: clock.now(), plannedDurationSeconds: 60)
        timer.start(state: state)
        XCTAssertEqual(timer.audibleTick, 0)
        clock.advance(by: 1); timer.tick(); XCTAssertEqual(timer.audibleTick, 1)
        timer.tick(); XCTAssertEqual(timer.audibleTick, 1)
        clock.advance(by: 60); timer.tick(); XCTAssertEqual(timer.audibleTick, 2)
        XCTAssertEqual(timer.overtimeSeconds, 1)
        var paused = state; paused.phase = .paused
        timer.reflectPause(paused)
        clock.advance(by: 2); timer.tick(); XCTAssertEqual(timer.audibleTick, 2)
        timer.stop(); clock.advance(by: 1); timer.tick(); XCTAssertEqual(timer.audibleTick, 2)
    }
}

final class RecordedClockAudioTests: XCTestCase {
    func test_installed_bundle_contains_distinct_decodable_tick_and_tock() throws {
        let sounds = try TickSoundGateway.loadRecordedTicks(bundle: Bundle(for: TickSoundGateway.self))
        XCTAssertEqual(sounds.count, 2)
        for sound in sounds {
            XCTAssertEqual(sound.format.sampleRate, 44_100)
            XCTAssertEqual(sound.format.channelCount, 1)
            XCTAssertEqual(sound.frameLength, 22_050)
            let samples = try XCTUnwrap(sound.floatChannelData?[0])
            let peak = (0..<Int(sound.frameLength)).map { abs(samples[$0]) }.max() ?? 0
            XCTAssertGreaterThan(peak, 0.1, "Recording must contain audible samples")
            XCTAssertLessThan(peak, 0.9, "Recording must have clipping headroom")
        }
        let tick = try XCTUnwrap(sounds[0].floatChannelData?[0])
        let tock = try XCTUnwrap(sounds[1].floatChannelData?[0])
        XCTAssertTrue((0..<22_050).contains { tick[$0] != tock[$0] })
    }
}
