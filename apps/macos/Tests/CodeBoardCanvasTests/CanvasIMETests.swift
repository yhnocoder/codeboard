import AppKit
import CodeBoardModel
import ObjectiveC
import Testing

@testable import CodeBoardCanvas

// Writing through an input method (Pinyin) and Esc, as on the board: one Esc after the text is committed leaves the
// editor with it; while a composition is in progress the first Esc only cancels it. The input method is this process's
// own: the native editors give each key to the input context, and an input method answers there
// by setting the marked text on the client or committing it, as `Pinyin` does here.
// The system's input sources are never touched.

/// A Pinyin input method for the keys WebKit or a native field hands the input context while `on`: letters compose,
/// Space commits the composition's characters, Esc cancels it; any other key, or any key but a letter with nothing
/// composed, goes on as with no input method
@MainActor enum Pinyin {
  /// The windows it takes keys in, and what is composed in each: suites run side by side, and another test's keys, in
  /// another window, are not its
  static var windows: Set<Int> = []
  static var composing: [Int: String] = [:]
  static let words = ["ni": "你", "hao": "好"]

  static func install() {
    guard !installed else { return }
    installed = true
    let c: AnyClass = NSTextInputContext.self
    // WebKit's way in (with a completion handler), and a native field's (AppKit's text views ask synchronously)
    if let a = class_getInstanceMethod(c, NSSelectorFromString("handleEventByInputMethod:completionHandler:")),
      let b = class_getInstanceMethod(c, #selector(NSTextInputContext.pinyinHandle(_:completionHandler:)))
    {
      method_exchangeImplementations(a, b)
    }
    // the system's Pinyin as the input source the view is told of (the person's is not changed): WebKit gives the page
    // its keys as it does for an input method (keyCode 229), not as for a keyboard layout
    if let a = class_getInstanceMethod(c, #selector(getter: NSTextInputContext.selectedKeyboardInputSource)) {
      let block: @convention(block) (NSTextInputContext) -> String? = { _ in "com.apple.inputmethod.SCIM.ITABC" }
      method_setImplementation(a, imp_implementationWithBlock(block))
    }
    if let a = class_getInstanceMethod(c, #selector(NSTextInputContext.handleEvent(_:))),
      let b = class_getInstanceMethod(c, #selector(NSTextInputContext.pinyinHandleNow(_:)))
    {
      method_exchangeImplementations(a, b)
    }
  }
  private static var installed = false

  /// Whether the input method took the key
  static func take(_ e: NSEvent, client: NSTextInputClient) -> Bool {
    let w = e.windowNumber
    guard windows.contains(w), e.type == .keyDown else { return false }
    var composing = self.composing[w, default: ""]
    defer { self.composing[w] = composing }
    let none = NSRange(location: NSNotFound, length: 0)
    let ch = e.charactersIgnoringModifiers ?? ""
    if ch.count == 1, let c = ch.first, c.isLetter, c.isASCII {
      composing.append(c)
      client.setMarkedText(
        composing, selectedRange: NSRange(location: composing.count, length: 0), replacementRange: none)
      return true
    }
    guard !composing.isEmpty else { return false }
    switch e.keyCode {
    case 49:  // Space: the characters
      client.insertText(words[composing] ?? composing, replacementRange: none)
    case 53:  // Esc: nothing
      client.setMarkedText("", selectedRange: NSRange(location: 0, length: 0), replacementRange: none)
      client.unmarkText()
    default:
      return true
    }
    composing = ""
    return true
  }
}

extension NSTextInputContext {
  @MainActor @objc func pinyinHandle(_ e: NSEvent, completionHandler: @escaping (Bool) -> Void) {
    if Pinyin.take(e, client: client) { return completionHandler(true) }
    // the system's own (exchanged)
    pinyinHandle(e, completionHandler: completionHandler)
  }

  @MainActor @objc func pinyinHandleNow(_ e: NSEvent) -> Bool {
    if Pinyin.take(e, client: client) { return true }
    return pinyinHandleNow(e)
  }
}

/// Windows this process takes as key, as for a person typing in them, without taking the focus: WebKit gives the page
/// the focus (document.hasFocus()) only in a key window, and CodeMirror follows the caret WebKit sets only while its
/// page has it
@MainActor enum KeyWindows {
  nonisolated(unsafe) static let windows = NSHashTable<NSWindow>.weakObjects()
  private static var installed = false

  static func add(_ w: NSWindow) {
    if !installed, let m = class_getInstanceMethod(NSWindow.self, #selector(getter: NSWindow.isKeyWindow)) {
      installed = true
      typealias Imp = @convention(c) (NSWindow, Selector) -> Bool
      let isKey = unsafeBitCast(method_getImplementation(m), to: Imp.self)
      let block: @convention(block) (NSWindow) -> Bool = { w in
        windows.contains(w) || isKey(w, #selector(getter: NSWindow.isKeyWindow))
      }
      method_setImplementation(m, imp_implementationWithBlock(block))
    }
    windows.add(w)
    NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: w)
  }
}

@MainActor @Suite(.serialized) struct CanvasIMETests {
  /// What the editor shows: its text and what is being composed
  func text(_ r: Rig) async -> String {
    guard let v = r.canvas.editing?.writer else { return "" }
    let m = v.markedRange()
    let marked = m.location == NSNotFound ? "" : v.attributedSubstring(forProposedRange: m, actualRange: nil)?.string
    return v.source + (marked ?? "")
  }

  /// "ni", Space: 你 is written; one Esc leaves with it
  @Test func oneEscAfterTheCompositionIsCommittedLeavesWithTheText() async throws {
    Pinyin.install()
    let r = try await Rig(zoom: 1)
    defer {
      Pinyin.windows.remove(r.window.windowNumber)
      r.close()
    }
    r.doubleClick(CGPoint(x: 800, y: 330))
    await r.editorReady()
    let id = try #require(r.canvas.editing?.id)
    Pinyin.windows.insert(r.window.windowNumber)
    r.press("ni ")
    await r.until("你 written") { await text(r).contains("你") }
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    #expect(r.doc.board.card(id)?.writing == "你")
  }

  /// "ni" and Space typed at once after the double-click, as the editor comes: they go through the input method too, so
  /// 你 is written, on a Note, a Text and a Box
  @Test(arguments: ["n1", "t1", "b1"])
  func pinyinTypedAtOnceAfterTheDoubleClickIsComposed(id: String) async throws {
    Pinyin.install()
    let r = try await Rig(zoom: 1)
    defer {
      Pinyin.windows.remove(r.window.windowNumber)
      r.close()
    }
    // a key window, as the one a person types in (CanvasFreeCodeTests has the same)
    KeyWindows.add(r.window)
    let before = r.doc.board.card(cid(id))?.writing ?? ""
    Pinyin.windows.insert(r.window.windowNumber)
    r.doubleClick(id == "n1" ? CGPoint(x: 40, y: 40) : r.centre(id))
    r.press("ni ")
    await r.editorReady()
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    let now = r.doc.board.card(cid(id))?.writing ?? ""
    #expect(now.contains("你") && now.count == before.count + 1, "\(before) → \(now)")
  }

  /// "ni", Space and at once Esc, on a Note, a Text and a Box being written: the Esc right after the commit leaves. Here
  /// WebKit gives the page the Space after the composition ends (a window that is not key: the input method answers
  /// through handleEventByInputMethod:completionHandler:), the order the editors' rule for it expects, and the page's
  /// guard for the other order (the Space first, as in the app's key window: Accept's ime-esc) must leave it alone
  @Test(arguments: ["n1", "t1", "b1"])
  func anEscAtOnceAfterTheCommitLeavesWithTheText(id: String) async throws {
    Pinyin.install()
    let r = try await Rig(zoom: 1)
    defer {
      Pinyin.windows.remove(r.window.windowNumber)
      r.close()
    }
    r.doubleClick(id == "n1" ? CGPoint(x: 40, y: 40) : r.centre(id))
    await r.editorReady()
    let before = r.doc.board.card(cid(id))?.writing ?? ""
    Pinyin.windows.insert(r.window.windowNumber)
    r.press("ni \u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    let now = r.doc.board.card(cid(id))?.writing ?? ""
    #expect(now.contains("你") && now.count == before.count + 1, "\(before) → \(now)")
  }

  /// "ni", Esc: the composition goes and the editor stays; what is typed then is written, and the next Esc leaves
  @Test func anEscDuringACompositionCancelsOnlyTheComposition() async throws {
    Pinyin.install()
    let r = try await Rig(zoom: 1)
    defer {
      Pinyin.windows.remove(r.window.windowNumber)
      r.close()
    }
    r.doubleClick(CGPoint(x: 800, y: 330))
    await r.editorReady()
    let id = try #require(r.canvas.editing?.id)
    Pinyin.windows.insert(r.window.windowNumber)
    r.press("ni")
    await r.until("composing") { await text(r).contains("ni") }
    r.press("\u{1b}")
    // a key after it, with nothing composed: once it is written, whatever the Esc did has happened
    r.press("1")
    await r.until("1 written") { await text(r).contains("1") }
    #expect(r.canvas.isEditing, "the Esc cancelled the composition only")
    #expect(await text(r).trimmingCharacters(in: .whitespacesAndNewlines) == "1", "nothing of the composition kept")
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    #expect(r.doc.board.card(id)?.writing == "1")
  }
}
