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
    private let alarmQueue = DispatchQueue(label: "com.mariusschober.goalflow.alarm", qos: .userInitiated)
    private var alarmEngine: AVAudioEngine?
    private var alarmPlayer: AVAudioPlayerNode?
    private var alarmGeneration: UInt64 = 0 // protected by lock
    private var tickEngine: AVAudioEngine?
    private var tickPlayer: AVAudioPlayerNode?
    private var tickGeneration: UInt64 = 0
    private var nextTickIndex = 0
    private lazy var recordedTicks: [AVAudioPCMBuffer] = {
        do { return try Self.loadRecordedTicks() }
        catch { NSLog("Tsurfing: recorded clock audio could not be loaded: %@", error.localizedDescription); return [] }
    }()

    static func loadRecordedTicks(bundle: Bundle = .main) throws -> [AVAudioPCMBuffer] {
        try ["clock-tick", "clock-tock"].map { name in
            guard let url = bundle.url(forResource: name, withExtension: "wav") else {
                throw CocoaError(.fileNoSuchFile)
            }
            let file = try AVAudioFile(forReading: url)
            guard file.length > 0,
                  let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat,
                                                frameCapacity: AVAudioFrameCount(file.length)) else {
                throw CocoaError(.fileReadCorruptFile)
            }
            try file.read(into: buffer)
            return buffer
        }
    }
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
        guard !recordedTicks.isEmpty else { return }
        let buf = recordedTicks[nextTickIndex]
        let format = buf.format
        // Retain the output graph across ticks. A temporary engine can be
        // released before playback, and stopping from its callback is unsafe.
        let engine: AVAudioEngine
        let player: AVAudioPlayerNode
        if let existingEngine = tickEngine, let existingPlayer = tickPlayer {
            engine = existingEngine; player = existingPlayer
        } else {
            engine = AVAudioEngine(); player = AVAudioPlayerNode()
            engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: format)
            tickEngine = engine; tickPlayer = player
        }
        do {
            if !engine.isRunning { try engine.start() }
            player.volume = max(0, min(1, volume))
            player.scheduleBuffer(buf, at: nil, options: .interrupts)
            nextTickIndex = (nextTickIndex + 1) % recordedTicks.count
            if !player.isPlaying { player.play() }
            tickGeneration &+= 1
            let generation = tickGeneration
            audioQueue.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard let self, self.tickGeneration == generation else { return }
                self.tickEngine?.pause()
            }
        } catch {
            tickEngine = nil; tickPlayer = nil
        }
    }
    func alarm(loop: Bool) {
        lock.lock()
        guard isEnabled, volume > 0 else { lock.unlock(); return }
        alarmGeneration &+= 1
        let generation = alarmGeneration
        let playbackVolume = volume
        lock.unlock()
        alarmQueue.async { [weak self] in
            guard let self, self.isCurrentAlarm(generation) else { return }
            self.playAlarm(loop: loop, volume: playbackVolume, generation: generation)
        }
    }
    func stopAlarm() {
        // Invalidate queued starts immediately; stop the current output on its
        // own queue, which is never blocked by sleeps or completion sounds.
        lock.lock(); alarmGeneration &+= 1; lock.unlock()
        alarmQueue.async { [weak self] in self?.stopAlarmOutput() }
    }
    private func isCurrentAlarm(_ generation: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return generation == alarmGeneration
    }
    private func stopAlarmOutput() {
        alarmPlayer?.stop()
        alarmEngine?.stop()
        alarmPlayer = nil
        alarmEngine = nil
    }
    private func playAlarm(loop: Bool, volume: Float, generation: UInt64) {
        stopAlarmOutput()
        let sampleRate: Double = 44_100
        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 33_075),
              let samples = buffer.floatChannelData?[0] else { return }
        buffer.frameLength = buffer.frameCapacity
        // One brief three-note alert with soft edges and silence between notes.
        for i in 0..<Int(buffer.frameLength) {
            let t = Double(i) / sampleRate
            let beatTime = t.truncatingRemainder(dividingBy: 0.25)
            let envelope = beatTime < 0.15 ? max(0, min(1, beatTime / 0.01, (0.15 - beatTime) / 0.02)) : 0
            samples[i] = Float(sin(2 * .pi * 880 * t) * envelope * 0.18)
        }
        let engine = AVAudioEngine(); let player = AVAudioPlayerNode()
        engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: format)
        alarmEngine = engine; alarmPlayer = player
        player.volume = max(0, min(1, volume))
        do {
            guard isCurrentAlarm(generation) else { stopAlarmOutput(); return }
            try engine.start()
            player.scheduleBuffer(buffer, at: nil, options: loop ? .loops : [], completionCallbackType: .dataPlayedBack) { [weak self] _ in
                guard !loop else { return }
                self?.alarmQueue.async { [weak self] in
                    guard let self, self.isCurrentAlarm(generation) else { return }
                    self.stopAlarmOutput()
                }
            }
            player.play()
        } catch { stopAlarmOutput() }
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
