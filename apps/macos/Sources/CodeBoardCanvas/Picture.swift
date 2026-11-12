import AppKit
import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax
import Synchronization

/// A card's soft shadow, as CSS draws an outer box-shadow: only outside the card
enum Shadow {
  /// Every layer of the theme's shadow around `card`; `scale`: device pixels per unit, as CoreGraphics shadows are drawn
  /// in device space (y-up)
  static func draw(_ t: Theme, card: CGRect, scale: CGFloat, in ctx: CGContext) {
    ctx.saveGState()
    ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    for l in t.shadow {
      ctx.saveGState()
      ctx.setShadow(offset: CGSize(width: 0, height: -l.y * scale), blur: l.blur * scale, color: l.color)
      let r = card.insetBy(dx: -l.spread, dy: -l.spread)
      let k = max(0, t.shadowRadius + l.spread)
      ctx.addPath(
        CGPath(roundedRect: r, cornerWidth: min(k, r.width / 2), cornerHeight: min(k, r.height / 2), transform: nil))
      ctx.setFillColor(CGColor(gray: 0, alpha: 1))
      ctx.fillPath()
      ctx.restoreGState()
    }
    ctx.setBlendMode(.clear)
    ctx.addPath(
      CGPath(roundedRect: card, cornerWidth: t.shadowRadius, cornerHeight: t.shadowRadius, transform: nil))
    ctx.fillPath()
    ctx.endTransparencyLayer()
    ctx.restoreGState()
  }

  /// A light line inside the top of a squircle (CSS inset 0 1px 0)
  static func innerTop(_ size: CGSize, radius: CGFloat) -> CGPath {
    let r = CGRect(origin: .zero, size: size)
    return Drawing.squircle(r, radius).subtracting(Drawing.squircle(r.offsetBy(dx: 0, dy: 1), radius))
  }
}

/// A theme's picture behind the board (an SVG of the Note page build, as the web board's stylesheet names it), drawn once
enum Backdrop {
  private static let drawn = Mutex<[String: CGImage]>([:])
  /// Wide enough for a large window on a 2x screen without visible softening of its soft gradients
  private static let width = 2400

  static func image(_ name: String) -> CGImage? {
    if let img = drawn.withLock({ $0[name] }) { return img }
    let folder = NoteRenderer.bundledPage.appending(path: "assets")
    guard
      let file = (try? FileManager.default.contentsOfDirectory(atPath: folder.path(percentEncoded: false)))?
        .first(where: { $0.hasPrefix(name + "-") && $0.hasSuffix(".svg") }),
      let svg = NSImage(contentsOf: folder.appending(path: file)), svg.size.width > 0
    else { return nil }
    let size = CGSize(width: CGFloat(width), height: (CGFloat(width) * svg.size.height / svg.size.width).rounded())
    guard
      let ctx = CGContext(
        data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return nil }
    var rect = CGRect(origin: .zero, size: size)
    guard
      let cg = svg.cgImage(
        forProposedRect: &rect, context: NSGraphicsContext(cgContext: ctx, flipped: false), hints: nil)
    else { return nil }
    ctx.draw(cg, in: CGRect(origin: .zero, size: size))
    let img = ctx.makeImage()
    drawn.withLock { $0[name] = img }
    return img
  }
}

/// The whole board as the canvas shows it at rest, drawn offscreen in one go: the look comparison's Swift half and tests.
/// Notes show their paper only (their content needs the Note renderer's web view)
package enum Picture {
  /// `rect` of the board (board units) at `scale` pixels per unit, the theme's backdrop covering it when asked; sizes: what
  /// the Note renderer would measure of Notes (as `Scene` takes it). Also returns where each card is
  package static func draw(
    board: Board, package: URL, vault: Vault, theme t: Theme, highlighter: Highlighter, sizes: [CardID: CGSize],
    rect: CGRect, scale: CGFloat, backdrop: Bool
  ) -> (image: CGImage?, cards: [String: CGRect]) {
    let scene = Scene(board, package: package, vault: vault, theme: t, highlighter: highlighter, sizes: sizes)
    var cards: [String: CGRect] = [:]
    for it in scene.items {
      switch it.drawing {
      case .code(let c): cards[c.id] = it.rect
      case .note(let n): cards[n.id] = it.rect
      case .image(let p): cards[p.id] = it.rect
      case .label: break
      }
    }
    return (draw(scene, theme: t, rect: rect, scale: scale, backdrop: backdrop), cards)
  }

  static func draw(_ s: Scene, theme t: Theme, rect: CGRect, scale: CGFloat, backdrop: Bool) -> CGImage? {
    let w = Int((rect.width * scale).rounded(.up))
    let h = Int((rect.height * scale).rounded(.up))
    guard
      let ctx = CGContext(
        data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return nil }
    ctx.setFillColor(t.canvas)
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    if backdrop, let img = t.backdrop.flatMap(Backdrop.image) {
      let k = max(CGFloat(w) / CGFloat(img.width), CGFloat(h) / CGFloat(img.height))
      let iw = CGFloat(img.width) * k
      ctx.interpolationQuality = .high
      ctx.draw(img, in: CGRect(x: (CGFloat(w) - iw) / 2, y: 0, width: iw, height: CGFloat(img.height) * k))
    }
    ctx.setShouldSmoothFonts(false)
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: scale, y: -scale)
    ctx.translateBy(x: -rect.minX, y: -rect.minY)
    for f in s.frames {
      ctx.saveGState()
      ctx.translateBy(x: f.rect.minX, y: f.rect.minY)
      let r = CGRect(origin: .zero, size: f.rect.size)
      if let strokes = f.strokes {
        ctx.setFillColor(f.fill)
        ctx.fill(r)
        ctx.addPath(strokes.cg)
        ctx.setFillColor(t.sectionEdge)
        ctx.fillPath()
      } else {
        let shape = Drawing.squircle(r, t.sectionRadius)
        ctx.addPath(shape)
        ctx.setFillColor(f.fill)
        ctx.fillPath()
        ctx.saveGState()
        ctx.addPath(shape)
        ctx.clip()
        ctx.addPath(Shadow.innerTop(r.size, radius: t.sectionRadius))
        ctx.setFillColor(t.sectionEdge)
        ctx.fillPath()
        ctx.restoreGState()
        ctx.addPath(Drawing.squircle(r.insetBy(dx: 0.25, dy: 0.25), t.sectionRadius - 0.25))
        ctx.setStrokeColor(t.hair)
        ctx.setLineWidth(0.5)
        ctx.strokePath()
      }
      ctx.restoreGState()
    }
    let images = DecodeCache(cap: 64 << 20)
    func item(_ it: Scene.Item) {
      ctx.saveGState()
      ctx.translateBy(x: it.rect.midX, y: it.rect.midY)
      ctx.rotate(by: it.tilt)
      ctx.translateBy(x: -it.rect.width / 2, y: -it.rect.height / 2)
      if it.drawing.framed {
        Shadow.draw(t, card: CGRect(origin: .zero, size: it.rect.size), scale: scale, in: ctx)
      }
      _ = it.drawing.draw(in: ctx, size: it.rect.size, scale: scale, theme: t, images: images)
      ctx.restoreGState()
    }
    for it in s.items[..<s.cardsFrom] { item(it) }
    for a in s.arrows {
      if !a.fill.isEmpty {
        ctx.addPath(a.fill.cg)
        ctx.setFillColor(a.color)
        ctx.fillPath()
      }
      if let p = a.stroke {
        ctx.saveGState()
        ctx.addPath(p.cg)
        ctx.setStrokeColor(a.color)
        ctx.setLineWidth(a.width)
        ctx.setLineCap(.round)
        ctx.setLineDash(phase: 0, lengths: [4, 4])
        ctx.strokePath()
        ctx.restoreGState()
      }
      if let p = a.dry {
        ctx.addPath(p.cg)
        ctx.setStrokeColor(t.dryBrush)
        ctx.setLineWidth(0.6)
        ctx.setLineCap(.round)
        ctx.strokePath()
      }
      if !a.heads.isEmpty {
        ctx.addPath(a.heads.cg)
        ctx.setFillColor(a.headColor)
        ctx.setStrokeColor(a.headColor)
        ctx.setLineWidth(a.headStroke)
        ctx.setLineJoin(.round)
        ctx.drawPath(using: .fillStroke)
      }
    }
    for it in s.items[s.labelsFrom...] { item(it) }
    for it in s.items[s.cardsFrom..<s.labelsFrom] { item(it) }
    return ctx.makeImage()
  }
}
