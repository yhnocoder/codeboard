import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardNotes

/// The editing web view with the real Note page (node web/build.mjs), in a window of its own far off screen
@MainActor @Suite(.serialized) struct NoteEditorTests {
  func editor() throws -> (NoteEditor, NSWindow) {
    _ = NSApplication.shared
    let page = NoteRenderer.bundledPage.appending(path: "page.html").path(percentEncoded: false)
    try #require(FileManager.default.fileExists(atPath: page), "build the Note page first: node web/build.mjs")
    let e = NoteEditor()
    e.drawOffScreen()
    let w = NSWindow(
      contentRect: CGRect(x: -30000, y: -30000, width: 900, height: 600), styleMask: .borderless, backing: .buffered,
      defer: false)
    w.isReleasedWhenClosed = false
    e.view.frame = CGRect(x: 0, y: 0, width: 900, height: 600)
    e.view.isHidden = false
    w.contentView?.addSubview(e.view)
    w.orderFrontRegardless()
    return (e, w)
  }

  @Test func itMountsTypesGrowsAndEndsWithWhatWasWritten() async throws {
    let (e, w) = try editor()
    defer { w.close() }
    var sizes: [CGSize] = []
    e.onSize = { sizes.append($0) }
    let size = try await e.begin(
      .text(TextCard(text: "Hello")), width: 200, height: nil, folder: FileManager.default.temporaryDirectory,
      look: "warm-ink", dark: false, k: 1, margin: 40, caret: nil, placeholder: "Type something…")
    #expect(size.width > 40 && size.height > 20)
    e.type(" world, and more")
    for _ in 0..<50 where (sizes.last?.width ?? 0) <= size.width { try await Task.sleep(for: .milliseconds(20)) }
    #expect((sizes.last?.width ?? 0) > size.width, "a Text not wrapping grows with its text")
    let written = await e.finish()
    #expect(written?.text == "Hello world, and more")
    e.clear()
  }

  @Test func escLeavesWithWhatWasWrittenAndNothingWrittenIsNil() async throws {
    let (e, w) = try editor()
    defer { w.close() }
    var done: NoteEditor.Written?
    e.onDone = { done = $0 }
    _ = try await e.begin(
      .note(Note(text: "# Plan\n\nsteps")), width: 300, height: nil, folder: FileManager.default.temporaryDirectory,
      look: "ink-wash", dark: true, k: 1.5, margin: 40, caret: nil, placeholder: "")
    _ = try await e.view.callAsyncJavaScript(
      "document.querySelector('.ProseMirror').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))",
      contentWorld: .page)
    for _ in 0..<50 where done == nil { try await Task.sleep(for: .milliseconds(20)) }
    #expect(done != nil && done?.text == nil, "nothing typed")
    e.clear()
  }

  @Test func aPictureIsStoredByItsContentOnce() throws {
    let folder = FileManager.default.temporaryDirectory.appending(path: "editor-images-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: folder) }
    // a 2 × 3 PNG
    let ctx = try #require(
      CGContext(
        data: nil, width: 2, height: 3, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    let image = try #require(ctx.makeImage())
    let png = try #require(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]))
    let url = "data:image/png;base64," + png.base64EncodedString()
    let a = try #require(try NoteEditor.store(dataURL: url, in: folder))
    #expect(a.hasPrefix("images/") && a.hasSuffix("-2x3.png") && a.count == "images/".count + 16 + "-2x3.png".count)
    #expect(try NoteEditor.store(dataURL: url, in: folder) == a)
    #expect(FileManager.default.fileExists(atPath: folder.appending(path: a).path(percentEncoded: false)))
    #expect(try NoteEditor.store(dataURL: "data:text/plain;base64,aGVsbG8=", in: folder) == nil)
  }
}
