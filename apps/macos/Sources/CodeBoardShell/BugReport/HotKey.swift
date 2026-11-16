import AppKit
import Carbon.HIToolbox

/// A shortcut that reaches the app wherever the person is, its windows in front or not: the Carbon hot key, which needs
/// no Accessibility permission and takes the keys from every app while it is registered
@MainActor final class HotKey {
  private var ref: EventHotKeyRef?
  private var handler: EventHandlerRef?
  private let action: @MainActor () -> Void

  /// ⌃⌥⌘B by default: the bug report's start and stop
  init?(
    key: Int = kVK_ANSI_B, modifiers: Int = controlKey | optionKey | cmdKey, action: @escaping @MainActor () -> Void
  ) {
    self.action = action
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    let me = Unmanaged.passUnretained(self).toOpaque()
    let installed = InstallEventHandler(
      GetApplicationEventTarget(),
      { _, _, data in
        guard let data else { return OSStatus(eventNotHandledErr) }
        // Carbon hands its events to the main thread
        MainActor.assumeIsolated { Unmanaged<HotKey>.fromOpaque(data).takeUnretainedValue().action() }
        return noErr
      }, 1, &spec, me, &handler)
    guard installed == noErr else { return nil }
    let id = EventHotKeyID(signature: OSType(0x4342_5247), id: 1)  // "CBRG"
    guard
      RegisterEventHotKey(UInt32(key), UInt32(modifiers), id, GetApplicationEventTarget(), 0, &ref) == noErr
    else {
      if let handler { RemoveEventHandler(handler) }
      return nil
    }
  }

  func unregister() {
    if let ref { UnregisterEventHotKey(ref) }
    if let handler { RemoveEventHandler(handler) }
    ref = nil
    handler = nil
  }
}

/// A small red dot at the right end of a window's title bar while it is being recorded: a window of its own, a child
/// of the recorded one so it moves with it, and left out of the video
@MainActor final class RecordingDot {
  let window: NSPanel
  private weak var parent: NSWindow?
  private var observer: NSObjectProtocol?
  static let size: CGFloat = 10

  init(over parent: NSWindow) {
    self.parent = parent
    window = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: Self.size, height: Self.size),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered, defer: false)
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.ignoresMouseEvents = true
    window.isReleasedWhenClosed = false
    window.collectionBehavior = [.fullScreenAuxiliary, .ignoresCycle]
    window.setAccessibilityElement(false)
    let dot = NSView(frame: NSRect(x: 0, y: 0, width: Self.size, height: Self.size))
    dot.wantsLayer = true
    dot.layer?.backgroundColor = NSColor.systemRed.cgColor
    dot.layer?.cornerRadius = Self.size / 2
    window.contentView = dot
    place()
    parent.addChildWindow(window, ordered: .above)
    observer = NotificationCenter.default.addObserver(
      forName: NSWindow.didResizeNotification, object: parent, queue: .main
    ) { [weak self] _ in MainActor.assumeIsolated { self?.place() } }
  }

  /// In the middle of the title bar's height, 14 points from the window's right edge
  private func place() {
    guard let parent else { return }
    let bar = max(28, parent.frame.height - parent.contentLayoutRect.height)
    let f = parent.frame
    window.setFrameOrigin(NSPoint(x: f.maxX - 14 - Self.size, y: f.maxY - bar / 2 - Self.size / 2))
  }

  func close() {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    parent?.removeChildWindow(window)
    window.orderOut(nil)
  }
}
