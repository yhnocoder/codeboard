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

/// A Pinyin input method for the keys WebKit or a native field hands the input context while `on`: letters compose, Space commits the
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
    // WebKit's way in (with a completion handler), and a native field's (AppKit's text views ask synchronously)
    if let a = class_getInstanceMethod(c, NSSelectorFromString("handleEventByInputMethod:completionHandler:")),
      let b = class_getInstanceMethod(c, #selector(NSTextInputContext.pinyinHandle(_:completionHandler:)))
    {
      method_exchangeImplementations(a, b)
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

extension Rig {
  /// The editor's page takes the focus a second late from now on, as on a busy machine: WebKit gives the web view its
  /// input context only then, so keys typed at once wait longer than a page frame or two
  func editorFocusesLate() async {
    let v = canvas.noteEditor.view
    await until("the editor page loaded") {
      (try? await v.callAsyncJavaScript("return typeof edit.focusLate", contentWorld: .page) as? String) == "function"
    }
    _ = try? await v.callAsyncJavaScript("edit.focusLate(1000)", contentWorld: .page)
  }

  /// Keys as a person types them, once the editor takes them itself: each once the page has had the one before (a burst
  /// would have the input method answer every key before the page saw the first)
  func typeInTurn(_ text: String) async {
    let v = canvas.noteEditor.view
    await until("the editor takes the keys itself") { v.held == nil && v.inputContext != nil }
    for ch in text {
      let n = (try? await v.callAsyncJavaScript("return edit.keysSeen()", contentWorld: .page) as? Int) ?? 0
      press(String(ch))
      _ = try? await v.callAsyncJavaScript(
        "return await edit.seen(n, 2000)", arguments: ["n": n + 1], contentWorld: .page)
    }
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
    await r.typeInTurn("ni ")
    await r.until("你 written") { await text(r).contains("你") }
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    #expect(r.doc.board.card(id)?.writing == "你")
  }

  /// "ni" and Space typed at once after the double-click, before the editor is there: they go through the input method
  /// too, so 你 is written (WebKit gives a web view an input context only once it has heard from the page that the
  /// focused element is editable; keys handed to it before that went past the input method)
  /// …on a Note, a Text and a Box, also when the editor takes the focus late (a busy machine): the keys wait for the
  /// input context however long it takes, then go in the order typed
  @Test(arguments: ["n1", "t1", "b1"], [false, true])
  func pinyinTypedAtOnceAfterTheDoubleClickIsComposed(id: String, late: Bool) async throws {
    Pinyin.install()
    let r = try await Rig(zoom: 1)
    defer {
      Pinyin.windows.remove(r.window.windowNumber)
      r.close()
    }
    if late { await r.editorFocusesLate() }
    let before = r.doc.board.card(cid(id))?.writing ?? ""
    Pinyin.windows.insert(r.window.windowNumber)
    r.doubleClick(id == "n1" ? CGPoint(x: 40, y: 40) : r.centre(id))
    r.press("ni ")
    await r.editorReady()
    await r.until("the keys handed over") { r.canvas.noteEditor.view.held == nil }
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    let now = r.doc.board.card(cid(id))?.writing ?? ""
    #expect(now.contains("你") && now.count == before.count + 1, "\(before) → \(now)")
  }

  /// Keys typed at once, then the writing left before the editor took them (its focus late): they are dropped, not
  /// written anywhere, and the keys after that reach the board
  @Test func keysTypedForAnEditorLeftBeforeItTookThemAreDropped() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    await r.editorFocusesLate()
    let before = r.doc.board.card(cid("n1"))?.writing
    r.doubleClick(CGPoint(x: 40, y: 40))
    r.press("xyz")
    await r.editorReady()
    await r.canvas.endEditing()
    await r.until("the keys let go") { r.canvas.noteEditor.view.held == nil }
    #expect(r.doc.board.card(cid("n1"))?.writing == before)
    #expect(!r.canvas.isEditing)
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
    await r.typeInTurn("ni \u{1b}")
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
    await r.typeInTurn("ni")
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
