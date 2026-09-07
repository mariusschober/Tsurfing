import Foundation
import Carbon
import AppKit

protocol HotkeyGateway: AnyObject, Sendable {
    func register(action: @escaping @Sendable () -> Void)
    func unregister()
}

// Default hotkey: Cmd+Shift+G (kVK_ANSI_G = 5)
final class CarbonHotkeyGateway: HotkeyGateway, @unchecked Sendable {
    private var hotKeyRef: EventHotKeyRef?
    private var eventHandlerRef: EventHandlerRef?
    private var action: (@Sendable () -> Void)?
    private let hotKeyID = EventHotKeyID(signature: OSType(0x47463031), id: 1) // 'GF01'

    deinit { unregister() }

    func register(action: @escaping @Sendable () -> Void) {
        self.action = action
        let shortcut = CaptureShortcut.load()
        let status = update(shortcut)
        if status != noErr { print("[Hotkey] Registration failed \(status)") }
    }

    @discardableResult
    func update(_ shortcut: CaptureShortcut) -> OSStatus {
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(shortcut.keyCode, shortcut.modifiers, hotKeyID, GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let ref else { return status }
        // Keep the previous working shortcut if registration fails.
        if let previous = hotKeyRef { UnregisterEventHotKey(previous) }
        hotKeyRef = ref
        if eventHandlerRef == nil { installHandler() }
        return noErr
    }

    func unregister() {
        if let ref = hotKeyRef { UnregisterEventHotKey(ref); hotKeyRef = nil }
        if let h = eventHandlerRef { RemoveEventHandler(h); eventHandlerRef = nil }
    }

    private func installHandler() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let handler: EventHandlerUPP = { _, event, userData -> OSStatus in
            guard let userData else { return noErr }
            let gateway = Unmanaged<CarbonHotkeyGateway>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async { gateway.action?() }
            return noErr
        }
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), handler, 1, &spec, selfPtr, &eventHandlerRef)
    }
}

final class NoopHotkeyGateway: HotkeyGateway, @unchecked Sendable {
    func register(action: @escaping @Sendable () -> Void) {}
    func unregister() {}
}

struct CaptureShortcut: Codable, Equatable {
    var key: String = "G"
    var command: Bool = true
    var shift: Bool = true
    var option: Bool = false
    var control: Bool = false
    static let keys: [(String, UInt32)] = [
        ("A",0),("B",11),("C",8),("D",2),("E",14),("F",3),("G",5),
        ("H",4),("I",34),("J",38),("K",40),("L",37),("M",46),("N",45),
        ("O",31),("P",35),("Q",12),("R",15),("S",1),("T",17),("U",32),
        ("V",9),("W",13),("X",7),("Y",16),("Z",6)
    ]
    var keyCode: UInt32 { Self.keys.first { $0.0 == key }?.1 ?? 5 }
    var modifiers: UInt32 {
        (command ? UInt32(cmdKey) : 0) | (shift ? UInt32(shiftKey) : 0)
        | (option ? UInt32(optionKey) : 0) | (control ? UInt32(controlKey) : 0)
    }
    var isValid: Bool { (command || control || option) && Self.keys.contains { $0.0 == key } }
    var label: String { (control ? "⌃" : "") + (option ? "⌥" : "") + (shift ? "⇧" : "") + (command ? "⌘" : "") + key }
    static func load() -> Self {
        guard let data = UserDefaults.standard.data(forKey: "tsurfing.captureShortcut"),
              let value = try? JSONDecoder().decode(Self.self, from: data), value.isValid else { return Self() }
        return value
    }
    func save() { if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: "tsurfing.captureShortcut") } }
}
