import AppKit
import CodeBoardMarkdown
import CoreGraphics
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// A drawn image in the editor (editor/inline.ts imageKey, image.ts): selected by a click, its width written by its
/// handles, ↵ opening its source, a typed key going after it, ⌫ taking it
@MainActor @Suite struct ImageTests {
  struct Sized: MarkdownResources {
    func imageSize(_ src: String) -> CGSize? { CGSize(width: 800, height: 400) }
    func ref(label: String, target: String?) -> MarkdownRefHit? { nil }
    func highlight(lines: [String], language: String) -> [[MarkdownToken]]? { nil }
    var mathPreamble: String { "" }
  }

  func view(_ src: String) -> MarkdownEditorView {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: Sized())
    return MarkdownEditorView(layout: l, caret: 0)
  }

  @Test func clickSelectsThenKeysAndWidth() {
    let src = "Text\n\n![pic](a.png)\n\nMore"
    let v = view(src)
    let atom = v.core.layout.rects(forAtom: 6..<19)!
    v.core.mouseDown(at: CGPoint(x: atom.midX, y: atom.midY), clicks: 1, extend: false)
    v.core.mouseUp()
    #expect(v.core.selectedImage?.range == 6..<19)
    #expect(v.imageBox != nil)
    v.core.setImageWidth(0.4)
    #expect(v.core.source == "Text\n\n![pic](a.png){width=40%}\n\nMore")
    #expect(v.core.selectedImage?.image.width == 0.4)
    v.core.setImageWidth(nil)
    #expect(v.core.source == src)
    v.core.undo()
    v.core.undo()
    #expect(v.core.source == src)
    v.core.select(MDSelection(anchor: 6, head: 19))
    #expect(v.core.key(.enter))
    #expect(v.selection == MDSelection(8))
    v.core.select(MDSelection(anchor: 6, head: 19))
    v.core.insert("x")
    #expect(v.core.source == "Text\n\n![pic](a.png)x\n\nMore")
    v.core.undo()
    v.core.select(MDSelection(anchor: 6, head: 19))
    v.core.key(.backspace)
    #expect(v.core.source == "Text\n\n\n\nMore")
  }
}

@MainActor @Suite struct ImageScaleTests {
  @Test func thePictureScalesUnderTheHandleAndTheSourceWaitsForTheRelease() {
    _ = boardFonts
    let src = "![pic](a.png)\n\nBelow the picture."
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: ImageTests.Sized())
    let e = EditorCore(layout: l)
    e.select(MDSelection(anchor: 0, head: 13))
    let below0 = l.blockFrames[1].minY
    let w0 = l.images[0].frame.width
    e.previewImageWidth(0.5)
    #expect(e.source == src)
    #expect(abs(l.images[0].frame.width - 150) < 1 && w0 > 150)
    // the text below follows the picture's new height
    #expect(l.blockFrames[1].minY < below0)
    e.previewImageWidth(0.6)
    #expect(abs(l.images[0].frame.width - 180) < 1)
    e.endImagePreview()
    #expect(l.document == e.document && abs(l.images[0].frame.width - w0) < 0.01)
    e.setImageWidth(0.6)
    #expect(e.source == "![pic](a.png){width=60%}\n\nBelow the picture.")
  }
}

@MainActor @Suite struct ImageClipboardTests {
  final class Host: MarkdownEditorDelegate {
    var saved: [(Int, String)] = []
    func editor(_ e: MarkdownEditorView, didResize size: CGSize) {}
    func editorWantsToEnd(_ e: MarkdownEditorView) {}
    func editorDidBegin(_ e: MarkdownEditorView) {}
    func editor(_ e: MarkdownEditorView, didChange source: String) {}
    func editor(_ e: MarkdownEditorView, saveImage data: Data, name: String) -> String? {
      saved.append((data.count, name))
      return "images/\(name)"
    }
  }

  @Test func picturesPastedAreSavedByTheHostAndWritten() {
    _ = boardFonts
    let l = BlockLayout(
      MarkdownDocument("Text"), width: 300, theme: testTheme, layout: nil, resources: ImageTests.Sized())
    let v = MarkdownEditorView(layout: l, caret: 4)
    let host = Host()
    v.delegate = host
    // a pasteboard of the test's own: the system clipboard is never touched
    let pb = NSPasteboard(name: NSPasteboard.Name("markdown-tests-\(UUID().uuidString)"))
    pb.clearContents()
    let ctx = CGContext(
      data: nil, width: 4, height: 4, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let png = NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:])!
    pb.setData(png, forType: .png)
    #expect(v.insertImages(from: pb))
    #expect(host.saved.count == 1 && host.saved[0].1 == "pasted.png")
    #expect(v.core.source == "Text![](images/pasted.png)")
    pb.releaseGlobally()
  }

  @Test func aClickOnTheCaptionOpensTheSourceThere() {
    _ = boardFonts
    let src = "![pic](a.png \"A caption\")"
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: ImageTests.Sized())
    let e = EditorCore(layout: l)
    let pic = l.images[0].frame
    let atom = l.rects(forAtom: 0..<src.utf16.count)!
    // under the picture, inside the image's box: its caption
    let p = CGPoint(x: pic.midX, y: min(atom.maxY - 2, pic.maxY + 8))
    e.mouseDown(at: p, clicks: 1, extend: false)
    e.mouseUp()
    #expect(e.selection == MDSelection(14))
  }
}
