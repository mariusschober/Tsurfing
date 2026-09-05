import Foundation
import AVFoundation
protocol SoundGateway: Sendable {
    func tick(volume: Float)
    func complete(frog: Bool)
    func alarm(loop: Bool)
    func stopAlarm()
    func setEnabled(_ enabled: Bool)
    func setVolume(_ volume: Float)
}
final class NoopSoundGateway: SoundGateway, @unchecked Sendable {
    func tick(volume: Float) {}
    func complete(frog: Bool) {}
    func alarm(loop: Bool) {}
    func stopAlarm() {}
    func setEnabled(_ enabled: Bool) {}
    func setVolume(_ volume: Float) {}
}
final class TickSoundGateway: SoundGateway, @unchecked Sendable {
    private var isEnabled: Bool = true; private var volume: Float = 0.6; private let lock = NSLock()
    private let audioQueue = DispatchQueue(label: "com.mariusschober.goalflow.sound", qos: .userInitiated)
    init() {}
    func setEnabled(_ enabled: Bool) { lock.lock(); defer { lock.unlock() }; isEnabled = enabled }
    func setVolume(_ volume: Float) { lock.lock(); defer { lock.unlock() }; self.volume = max(0, min(1, volume)) }
    func tick(volume vol: Float) {
        let (enabled, baseVol): (Bool, Float) = { lock.lock(); defer { lock.unlock() }; return (isEnabled, volume) }()
        guard enabled else { return }
        let v = baseVol * max(0, vol); guard v > 0.01 else { return }
        audioQueue.async { [weak self] in self?.playTick(volume: v) }
    }
    func complete(frog: Bool) {
        let (enabled, baseVol): (Bool, Float) = { lock.lock(); defer { lock.unlock() }; return (isEnabled, volume) }()
        guard enabled else { return }
        audioQueue.async { [weak self] in self?.playCompletion(frog: frog, volume: baseVol) }
    }
    private func playTick(volume: Float) {
        let sampleRate: Double = 44_100; let duration: Double = 0.05
        let frames = AVAudioFrameCount(sampleRate * duration)
        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1) else { return }
        guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
        buf.frameLength = frames
        guard let ptr = buf.floatChannelData?[0] else { return }
        for i in 0..<Int(frames) {
            let noise = Float.random(in: -1...1)
            let t = Float(i) / Float(sampleRate)
            let band = sin(2 * .pi * 1500 * t) * 0.5
            let envelope: Float = (i < Int(frames) * 4 / 5) ? 1.0 : exp(-Float(i - Int(frames)*4/5) * 0.02)
            ptr[i] = (noise * 0.3 + band * 0.7) * envelope * volume * 0.18
        }
        let engine = AVAudioEngine(); let player = AVAudioPlayerNode()
        engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: format)
        do { try engine.start(); player.play(); player.scheduleBuffer(buf, at: nil, options: .interrupts, completionHandler: { engine.stop() }) } catch {}
    }
    func alarm(loop: Bool) {
        audioQueue.async { [weak self] in self?.playAlarm(loop: loop) }
        // Async variant available via playAlarmAsync for future non-blocking use
    }
    func stopAlarm() {
        // No persistent looping state yet - playAlarm burst is finite, so stop is no-op for now
    }
    private func playAlarm(loop: Bool) {
        let repeats = loop ? 2 : 1
        for _ in 0..<repeats {
            playAlarmBurst()
            if loop { Thread.sleep(forTimeInterval: 0.8) }
        }
    }
    private func playAlarmBurst() {
        let sampleRate: Double = 44_100
        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1) else { return }
        let engine = AVAudioEngine(); let player = AVAudioPlayerNode()
        engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: format)
        do {
            try engine.start(); player.play()
            let beeps: [(Float, Double, Double)] = [(880,0.15,0.0),(880,0.15,0.2),(880,0.15,0.4),(880,0.15,1.0),(880,0.15,1.2),(880,0.15,1.4)]
            for (freq, dur, delay) in beeps {
                Thread.sleep(forTimeInterval: delay == 0 ? 0 : 0.2)
                let frames = AVAudioFrameCount(sampleRate * dur)
                guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { continue }
                buf.frameLength = frames
                guard let ptr = buf.floatChannelData?[0] else { continue }
                for i in 0..<Int(frames) {
                    let phase = 2 * .pi * Double(freq) * Double(i) / sampleRate
                    ptr[i] = Float(sin(phase) * 0.22)
                }
                player.scheduleBuffer(buf, at: nil, options: .interrupts)
                Thread.sleep(forTimeInterval: dur)
            }
            Thread.sleep(forTimeInterval: 0.2); engine.stop()
        } catch {}
    }
    private func playCompletion(frog: Bool, volume: Float) {
        let notes: [(Float, Double)] = frog ? [(523.25,0.13),(659.25,0.13),(783.99,0.13),(1046.50,0.22)] : [(880.0,0.18),(1046.50,0.22)]
        let sampleRate: Double = 44_100
        let gap: Double = 0.025
        var buffers: [AVAudioPCMBuffer] = []
        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1) else { return }
        for (freq, dur) in notes {
            let frames = AVAudioFrameCount(sampleRate * dur)
            guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { continue }
            buf.frameLength = frames
            guard let ptr = buf.floatChannelData?[0] else { continue }
            for i in 0..<Int(frames) {
                let t = Float(i) / Float(sampleRate)
                let attack = min(1, Float(i) / Float(sampleRate * 0.012))
                let release = min(1, Float(Int(frames) - i) / Float(sampleRate * 0.045))
                let env = max(0, min(1, attack * release * 0.22)) * volume
                let phase = 2.0 * .pi * Double(freq) * Double(t)
                let sample: Double = sin(phase) * Double(env) * 0.22
                ptr[i] = Float(sample)
            }
            buffers.append(buf)
        }
        let engine = AVAudioEngine(); let player = AVAudioPlayerNode()
        engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: format)
        do {
            try engine.start(); player.play()
            for buf in buffers { player.scheduleBuffer(buf, at: nil, options: .interrupts); Thread.sleep(forTimeInterval: Double(buf.frameLength)/sampleRate + gap) }
            Thread.sleep(forTimeInterval: 0.08); engine.stop()
        } catch {}
    }
}
