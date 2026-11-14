import AppKit
import CodeBoardModel
import ObjectiveC
import Testing

@testable import CodeBoardCanvas

// Writing through an input method (Pinyin) and Esc, as on the board: one Esc after the text is committed leaves the
// editor with it; while a composition is in progress the first Esc only cancels it. The input method is this process's
// own: WebKit gives each key to the input context (handleEventByInputMethod:completionHandler:), and an input method
// answers there by setting the marked text on the client or committing it before it completes, as `Pinyin` does here.
// The system's input sources are never touched.

/// A Pinyin input method for the keys WebKit hands the input context while `on`: letters compose, Space commits the
/// composition's characters, Esc cancels it; any other key, or any key but a letter with nothing composed, goes on as
/// with no input method
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
    guard let a = class_getInstanceMethod(c, NSSelectorFromString("handleEventByInputMethod:completionHandler:")),
      let b = class_getInstanceMethod(c, #selector(NSTextInputContext.pinyinHandle(_:completionHandler:)))
    else { return }
    method_exchangeImplementations(a, b)
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
}

@MainActor @Suite(.serialized) struct CanvasIMETests {
  func text(_ r: Rig) async -> String {
    (try? await r.canvas.noteEditor.view.callAsyncJavaScript(
      "return document.querySelector('#root .slot.shown .card')?.innerText ?? ''", contentWorld: .page) as? String)
      ?? ""
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
