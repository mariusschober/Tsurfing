import Foundation
import AVFoundation
protocol TTSGateway: Sendable { func speakReminder(for task: GoalflowTask, remaining: Int) async; func setEnabled(_ enabled: Bool) }
final class NoopTTSGateway: TTSGateway, @unchecked Sendable { func speakReminder(for task: GoalflowTask, remaining: Int) async {}; func setEnabled(_ enabled: Bool) {} }
final class AVTTSGateway: TTSGateway, @unchecked Sendable {
    private var isEnabled = false; private let lock = NSLock(); private let synthesizer = AVSpeechSynthesizer()
    func setEnabled(_ enabled: Bool) { lock.lock(); defer { lock.unlock() }; isEnabled = enabled }
    func speakReminder(for task: GoalflowTask, remaining: Int) async {
        lock.lock(); let enabled = isEnabled; lock.unlock(); guard enabled else { return }
        let text: String
        if remaining > 0 && remaining <= 600 { let m = remaining / 60; text = "\(m) minutes left — \(task.title)" } else { text = task.title }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = 0.5; utterance.volume = 0.9
        synthesizer.speak(utterance)
    }
}
