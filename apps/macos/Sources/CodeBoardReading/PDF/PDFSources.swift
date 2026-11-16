import AppKit
import CodeBoardModel
import CodeBoardResources
import PDFKit

/// What the board asks about the sources its cards name, answered from the pane's entries: an entry's title and the
/// page for its source line; a region of a plain PDF's page (the whole page without a rect) as a picture; the passage
/// shown in a tab
@MainActor public final class ReadingSources: SourceProvider {
  let pane: ReadingPane
  public var onSourcesChanged: (() -> Void)?

  public init(pane: ReadingPane) {
    self.pane = pane
  }

  public func sourceLabel(_ a: SourceAnchor) -> SourceLabel? {
    guard let found = pane.entries[a.entry], found.entry.versions.contains(where: { $0.id == a.place.version }) else {
      return nil
    }
    var number: String?
    if case .page(let n, _) = a.place.block { number = "p. \(n)" }
    return SourceLabel(title: found.entry.title, number: number, icon: .paper)
  }

  public func blockSize(_ a: SourceAnchor) -> CGSize? { region(a).map(\.rect.size) }

  public func blockImage(_ a: SourceAnchor, pixelWidth: Int) async -> CGImage? {
    guard let (page, r) = region(a), pixelWidth > 0, r.width > 0 else { return nil }
    let scale = CGFloat(pixelWidth) / r.width
    let height = max(1, Int((r.height * scale).rounded()))
    guard
      let ctx = CGContext(
        data: nil, width: pixelWidth, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    ctx.setFillColor(CGColor(gray: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: pixelWidth, height: height))
    ctx.scaleBy(x: scale, y: scale)
    let box = page.bounds(for: .cropBox)
    ctx.translateBy(x: box.minX - r.minX, y: box.minY - r.minY)
    page.draw(with: .cropBox, to: ctx)
    return ctx.makeImage()
  }

  public func reveal(_ a: SourceAnchor) {
    guard let tab = pane.openPDF(.entry(a.entry, version: a.place.version)) else { return }
    PDFTabView.reveal(a.place, in: tab)
  }

  /// The page a page block is on and its region (in the page's space, from its crop box's bottom left; the whole box
  /// without a rect)
  private func region(_ a: SourceAnchor) -> (page: PDFPage, rect: CGRect)? {
    guard case .page(let n, let rect) = a.place.block,
      let found = pane.locate(.entry(a.entry, version: a.place.version), scanning: false),
      let data = try? Data(contentsOf: found.url, options: .mappedIfSafe), let doc = PDFDocument(data: data),
      n >= 1, n <= doc.pageCount, let page = doc.page(at: n - 1)
    else { return nil }
    let box = page.bounds(for: .cropBox)
    let r = rect.map { CGRect(x: box.minX + $0.x, y: box.minY + $0.y, width: $0.width, height: $0.height) } ?? box
    return (page, r)
  }
}
