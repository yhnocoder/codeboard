import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import PDFKit
import Testing

@testable import CodeBoardReading

/// A small PDF made here: each string a page of 300 × 400 points, its text drawn from the top left in lines
func makePDF(_ pages: [String]) -> Data {
  let data = NSMutableData()
  var box = CGRect(x: 0, y: 0, width: 300, height: 400)
  let ctx = CGContext(consumer: CGDataConsumer(data: data as CFMutableData)!, mediaBox: &box, nil)!
  for text in pages {
    ctx.beginPDFPage(nil)
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
    (text as NSString).draw(
      in: CGRect(x: 20, y: 20, width: 260, height: 360), withAttributes: [.font: NSFont.systemFont(ofSize: 14)])
    NSGraphicsContext.current = nil
    ctx.endPDFPage()
  }
  ctx.closePDF()
  return data as Data
}

/// A one-page paper made here: `title` (when given) drawn large at the top, `body` small under it; `info` its document
/// info's Title and Author
func makePaperPDF(title: String?, body: String, info: (title: String?, author: String?) = (nil, nil)) -> Data {
  let data = NSMutableData()
  var box = CGRect(x: 0, y: 0, width: 300, height: 400)
  var aux: [CFString: String] = [:]
  aux[kCGPDFContextTitle] = info.title
  aux[kCGPDFContextAuthor] = info.author
  let ctx = CGContext(consumer: CGDataConsumer(data: data as CFMutableData)!, mediaBox: &box, aux as CFDictionary)!
  ctx.beginPDFPage(nil)
  NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
  (title as NSString?)?.draw(
    in: CGRect(x: 20, y: 300, width: 260, height: 80), withAttributes: [.font: NSFont.boldSystemFont(ofSize: 22)])
  (body as NSString).draw(
    in: CGRect(x: 20, y: 20, width: 260, height: 270), withAttributes: [.font: NSFont.systemFont(ofSize: 10)])
  NSGraphicsContext.current = nil
  ctx.endPDFPage()
  ctx.closePDF()
  return data as Data
}

/// A page of two columns, each string drawn in its own from the top: the left from x 20 to 140, the right from 160
func makeColumnsPDF(_ left: String, _ right: String) -> Data {
  let data = NSMutableData()
  var box = CGRect(x: 0, y: 0, width: 300, height: 400)
  let ctx = CGContext(consumer: CGDataConsumer(data: data as CFMutableData)!, mediaBox: &box, nil)!
  ctx.beginPDFPage(nil)
  NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
  for (text, x) in [(left, 20.0), (right, 160.0)] {
    (text as NSString).draw(
      in: CGRect(x: x, y: 20, width: 120, height: 360), withAttributes: [.font: NSFont.systemFont(ofSize: 14)])
  }
  NSGraphicsContext.current = nil
  ctx.endPDFPage()
  ctx.closePDF()
  return data as Data
}

let samplePages = [
  "The river runs north past the mill.\nBirds rest on the far bank.",
  "Evening light falls on the water.\nA boat waits at the pier.",
]

/// A vault in a temporary folder with a resource Papers and, in it, the file `Field notes.pdf` that is an entry alone
struct PDFVault {
  let vault: Vault
  let resource: VaultResource
  /// The file's path in the vault
  let file: String

  /// `data`: the file, instead of one made of `pages`
  init(pages: [String] = samplePages, data: Data? = nil) throws {
    let root = FileManager.default.temporaryDirectory.appending(path: "pdf-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    vault = Vault(root: root)
    resource = try vault.newResource(in: "", title: "Papers", preset: .papers)
    file = "\(resource.path)/Field notes.pdf"
    try (data ?? makePDF(pages)).write(to: vault.url(of: file))
  }

  func remove() { try? FileManager.default.removeItem(at: vault.root) }

  /// Every file under the vault with its contents
  func files() -> [String: Data] {
    var out: [String: Data] = [:]
    let e = FileManager.default.enumerator(at: vault.root, includingPropertiesForKeys: nil)
    while let u = e?.nextObject() as? URL {
      if let d = try? Data(contentsOf: u), let p = vault.path(of: u) { out[p] = d }
    }
    return out
  }
}

/// A reading pane on the vault, its entries read, and its view in a window that is never shown
@MainActor final class PDFWindow {
  let pane = ReadingPane()
  let paneView: ReadingPaneView
  let window: NSWindow
  let pasteboard = NSPasteboard(name: NSPasteboard.Name("pdf-tests-\(UUID().uuidString)"))
  var collected: [Collected] = []

  init(_ v: PDFVault) throws {
    ReadingKinds.registerBuiltIn()
    pane.vault = v.vault
    pane.entries = EntryIndex(v.vault, try v.vault.tree())
    pane.pasteboard = pasteboard
    paneView = ReadingPaneView(pane: pane)
    window = NSWindow(
      contentRect: CGRect(x: 0, y: 0, width: 520, height: 900), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = paneView
    pane.onCollect = { [weak self] in self?.collected.append($0) }
  }

  /// The tab's view, made as the pane makes it
  func tab(_ id: ReadingTab.ID) throws -> PDFTabView {
    paneView.sync()
    window.contentView?.layoutSubtreeIfNeeded()
    let t = try #require(paneView.views[id] as? PDFTabView)
    t.layoutSubtreeIfNeeded()
    t.pdf.goToFirstPage(nil)
    t.layoutSubtreeIfNeeded()
    return t
  }

  func close() {
    pasteboard.releaseGlobally()
    window.contentView = nil
  }

  /// Text of a page selected, as a person selects it with the mouse; then the mouse lets go (what PagesView.mouseDown
  /// does once PDFKit has followed the drag, which a test cannot drive: it follows the drag from the event queue, and
  /// events in the queue end the test process)
  func select(_ t: PDFTabView, _ words: String, page: Int = 0) throws {
    let p = try #require(t.pdf.document?.page(at: page))
    t.pdf.setCurrentSelection(p.selection(for: (try #require(p.string) as NSString).range(of: words)), animate: false)
    t.released()
  }
}
