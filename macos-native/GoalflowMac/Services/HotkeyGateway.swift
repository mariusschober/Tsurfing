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
        unregister()
        var ref: EventHotKeyRef?
        let mods: UInt32 = UInt32(cmdKey | shiftKey)
        let keyCode: UInt32 = UInt32(kVK_ANSI_G)
        let status = RegisterEventHotKey(keyCode, mods, hotKeyID, GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let r = ref else {
            print("[Hotkey] RegisterEventHotKey failed \(status)")
            return
        }
        hotKeyRef = r
        installHandler()
        print("[Hotkey] Registered Cmd+Shift+G")
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
