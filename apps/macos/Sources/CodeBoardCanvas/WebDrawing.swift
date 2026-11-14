import AppKit
import CodeBoardModel
import CoreText
import Foundation

// Web cards and Link Lists drawn as the web board draws them (cards/WebBody.tsx, cards/web.css): a bookmark of the page
// (its title, description, site with its icon, its picture beside it, above it or not at all, or one compact row), what
// shows when nothing could be read (the domain's initial, the domain, the path, Retry and Edit Title), and a list of
// such rows under a header. The same layout gives a card's height, its parts' places for clicks, and the drawing.

extension Drawing {
  /// One page as a card or a list's row shows it
  struct Page: Sendable {
    var url: String
    var title: String?
    var desc: String?
    var site: String?
    var image: URL?
    var imageSize: CGSize
    var icon: URL?
    var iconSize: CGSize

    var domain: String { domainOf(url) }
    var path: String { urlPath(url) }
    /// Nothing to show of the page itself
    var none: Bool { title == nil && desc == nil }
    /// The site row's text: "domain · site" when the site's name is not in the domain
    var siteText: String {
      guard let s = site, !s.isEmpty, !domain.lowercased().contains(s.lowercased()) else { return domain }
      return "\(domain) · \(s)"
    }
  }

  struct Web: Sendable {
    var id: String
    var page: Page
    var style: WebCard.Style
    /// Its page is being read now
    var loading: Bool
  }

  struct Links: Sendable {
    var id: String
    var title: String
    var rows: [Row]

    struct Row: Sendable {
      var id: String
      var page: Page
      var rich: Bool
    }
  }
}

/// Where a bookmark's parts are, from its top left
struct WebLayout {
  enum Shape: Equatable {
    case banner, side, text, compact, none
  }

  var shape: Shape
  var height: CGFloat
  var image: CGRect?
  var title: (lines: [CTLine], at: CGPoint, font: Font)
  var desc: [CTLine]
  var descAt: CGPoint
  var site: CGPoint?
  var fav: CGRect
  /// What nothing read shows: the path, and Retry and Edit Title (or Fetching preview…)
  var path: [CTLine] = []
  var pathAt = CGPoint.zero
  var retry: CGRect?
  var edit: CGRect?
  var actsAt: CGPoint?
  var domain: (line: CTLine, at: CGPoint)?

  static let titleLine: CGFloat = 13.5 * 1.4
  static let descLine: CGFloat = 12 * 1.5
  static let siteLine: CGFloat = 15
  static let pathLine: CGFloat = 11 * 1.45

  /// The card's whole layout at `width`: as the card (small: a Link List's rich row)
  static func of(
    _ p: Drawing.Page, style: WebCard.Style, width w: CGFloat, small: Bool, loading: Bool, _ t: Theme
  ) -> WebLayout {
    let f = WebFonts(t)
    let hasImage =
      p.image != nil && style != .text && style != .compact && !small
      || (small && p.image != nil)
    let wide = p.imageSize.width > p.imageSize.height * 1.4
    var shape: Shape =
      p.none
      ? .none
      : style == .compact
        ? .compact
        : !hasImage ? .text : !small && (style == .banner || (style == .automatic && wide)) ? .banner : .side
    if small && shape == .compact { shape = .text }
    let titleFont = small ? f.title13 : f.title
    let titleLH = small ? 13 * 1.4 : titleLine
    switch shape {
    case .compact:
      // one row: the icon, the title, the domain (40 % at most) at the right
      let h: CGFloat = 9 + titleLH + 9
      let dw = min(Drawing.width(p.domain, f.site) + 1, 0.4 * (w - 24))
      let tw = w - 24 - 14 - 10 - 10 - dw
      let title = Drawing.wrap(p.title ?? p.domain, titleFont, t.ink, width: tw, max: 1)
      return WebLayout(
        shape: .compact, height: h.rounded(), image: nil, title: (title, CGPoint(x: 12 + 14 + 10, y: 9), titleFont),
        desc: [], descAt: .zero, site: nil, fav: CGRect(x: 12, y: (h - 14) / 2, width: 14, height: 14),
        domain: (Drawing.cut(p.domain, f.site, t.ink3, dw), CGPoint(x: w - 12 - dw, y: h / 2)))
    case .none:
      if small {
        // one line: the initial, the domain (55 % at most), the path
        let h: CGFloat = 10 + titleLH + 10
        let x0: CGFloat = 14 + 14 + 8
        let tw = min(Drawing.width(p.domain, titleFont) + 1, 0.55 * (w - 26))
        let title = Drawing.wrap(p.domain, titleFont, t.ink, width: tw, max: 1)
        let path = Drawing.wrap(p.path, f.path, t.ink3, width: max(0, w - 12 - x0 - tw - 8), max: 1, breakAll: true)
        return WebLayout(
          shape: .none, height: h.rounded(), image: nil, title: (title, CGPoint(x: x0, y: 10), titleFont), desc: [],
          descAt: .zero, site: nil, fav: CGRect(x: 14, y: (h - 14) / 2, width: 14, height: 14), path: path,
          pathAt: CGPoint(x: x0 + tw + 8, y: (h - pathLine) / 2))
      }
      let x0: CGFloat = 14 + 24 + 8
      let tw = w - x0 - 14 - 54
      let title = Drawing.wrap(p.domain, titleFont, t.ink, width: tw, max: 2)
      let th = max(24, CGFloat(title.count) * titleLH)
      var y: CGFloat = 12 + th
      let path = p.path.isEmpty ? [] : Drawing.wrap(p.path, f.path, t.ink3, width: w - 28, max: 2, breakAll: true)
      let pathAt = CGPoint(x: 14, y: y + 5)
      if !path.isEmpty { y += 5 + CGFloat(path.count) * pathLine }
      let acts = CGPoint(x: 14, y: y + 5 + 2)
      y += 5 + 2 + 16 + 11
      let retryW = Drawing.width("↻ Retry", f.site) + 8
      let editW = Drawing.width("✎ Edit Title", f.site) + 8
      let sepW = Drawing.width("·", f.site)
      return WebLayout(
        shape: .none, height: y.rounded(), image: nil,
        title: (title, CGPoint(x: x0, y: 12 + (th - CGFloat(title.count) * titleLH) / 2), titleFont), desc: [],
        descAt: .zero, site: nil, fav: CGRect(x: 14, y: 12 + (th - 24) / 2, width: 24, height: 24), path: path,
        pathAt: pathAt, retry: loading ? nil : CGRect(x: acts.x - 2, y: acts.y, width: retryW, height: 16),
        edit: loading ? nil : CGRect(x: acts.x - 2 + retryW + 4 + sepW + 4, y: acts.y, width: editW, height: 16),
        actsAt: acts)
    case .banner, .side, .text:
      let pad = small ? (t: 10.0, r: 12.0, b: 10.0, l: 14.0) : (t: 12.0, r: 14.0, b: 11.0, l: 14.0)
      let gap: CGFloat = small ? 4 : 5
      var imageRect: CGRect?
      var top: CGFloat = 0
      var mainW = w
      if shape == .banner {
        let ih = min(w / 1.91, 220).rounded()
        imageRect = CGRect(x: 0, y: 0, width: w, height: ih)
        top = ih + 1
      } else if shape == .side {
        let iw = small ? 96 : min(0.3 * w, 156).rounded()
        mainW = w - iw - (small ? 12 : 0)
        imageRect =
          small ? CGRect(x: w - 12 - 96, y: 10, width: 96, height: 60) : CGRect(x: mainW, y: 0, width: iw, height: 0)
      }
      let padRight: CGFloat = shape == .text && !small ? 54 : 0
      let title = Drawing.wrap(p.title ?? p.domain, titleFont, t.ink, width: mainW - pad.l - pad.r - padRight, max: 2)
      var y = top + pad.t
      let titleAt = CGPoint(x: pad.l, y: y)
      y += CGFloat(title.count) * titleLH
      var desc: [CTLine] = []
      var descAt = CGPoint.zero
      if let d = p.desc, !d.isEmpty {
        desc = Drawing.wrap(d, f.desc, t.ink2, width: mainW - pad.l - pad.r, max: 2)
        descAt = CGPoint(x: pad.l, y: y + gap)
        y += gap + CGFloat(desc.count) * descLine
      }
      let site = CGPoint(x: pad.l, y: y + gap + 1)
      y += gap + 1 + siteLine + pad.b
      var h = y
      if shape == .side {
        if small {
          h = max(h, 80)
        } else {
          h = max(h, 84)
          imageRect?.size.height = h
        }
      }
      return WebLayout(
        shape: shape, height: h.rounded(), image: imageRect, title: (title, titleAt, titleFont), desc: desc,
        descAt: descAt, site: site, fav: CGRect(x: site.x, y: site.y + (siteLine - 14) / 2, width: 14, height: 14))
    }
  }
}

/// The fonts a bookmark uses: the board's sans (Ink Wash: its serif)
struct WebFonts {
  let title: Font
  let title13: Font
  let rowTitle: Font
  let desc: Font
  let site: Font
  let initial: Font
  let initialBig: Font
  let path: Font
  let header: Font
  let count: Font

  init(_ t: Theme) {
    let serif = t.id == .inkWash
    func sys(_ size: CGFloat, _ w: NSFontWeightValue) -> Font {
      if serif, let f = Font.board("SourceSerif4-400-600", size: size, weight: w.css, opticalSize: true) { return f }
      return Font(NSFont.systemFont(ofSize: size, weight: w.ns))
    }
    title = sys(13.5, .semibold)
    title13 = sys(13, .semibold)
    rowTitle = sys(12.5, .semibold)
    desc = sys(12, .regular)
    site = sys(11.5, .regular)
    initial = Font(NSFont.systemFont(ofSize: 9, weight: .bold))
    initialBig = Font(NSFont.systemFont(ofSize: 12, weight: .bold))
    path = Font.board("JetBrainsMono-400-600", size: 11, weight: 400) ?? Font.mono(11, .regular)
    header = serif ? sys(13, .semibold) : sys(12, .medium)
    count = Font.board("JetBrainsMono-400-600", size: 10.5, weight: 600) ?? Font.mono(10.5, .semibold)
  }
}

enum NSFontWeightValue {
  case regular, medium, semibold

  var css: CGFloat {
    switch self {
    case .regular: 400
    case .medium: 500
    case .semibold: 600
    }
  }

  var ns: NSFont.Weight {
    switch self {
    case .regular: .regular
    case .medium: .medium
    case .semibold: .semibold
    }
  }
}

/// Where a Link List's parts are, from its top left
struct LinksLayout {
  var height: CGFloat
  /// Each row's rect and its bookmark's layout (Rich) or its compact parts
  var rows: [(rect: CGRect, rich: WebLayout?, compact: WebLayout?)]

  static func of(_ l: Drawing.Links, width w: CGFloat, _ t: Theme) -> LinksLayout {
    var y = t.headerHeight + 2
    var rows: [(CGRect, WebLayout?, WebLayout?)] = []
    for (i, r) in l.rows.enumerated() {
      let last = i == l.rows.count - 1
      if r.rich {
        let b = WebLayout.of(r.page, style: .automatic, width: w, small: true, loading: false, t)
        rows.append((CGRect(x: 0, y: y + 2, width: w, height: b.height + 3), b, nil))
        y += 2 + b.height + 3 + (last ? 0 : 1)
      } else {
        let c = WebLayout.compactRow(r.page, width: w, t)
        rows.append((CGRect(x: 0, y: y, width: w, height: 32), nil, c))
        y += 32 + (last ? 0 : 1)
      }
    }
    return LinksLayout(height: (y + 3).rounded(), rows: rows)
  }
}

extension WebLayout {
  /// A Link List's Compact row (.lcompact): 32 tall, the icon, the title, the domain (40 % at most) at the right
  static func compactRow(_ p: Drawing.Page, width w: CGFloat, _ t: Theme) -> WebLayout {
    let f = WebFonts(t)
    let dw = min(Drawing.width(p.domain, f.site) + 1, 0.4 * (w - 26))
    let x0: CGFloat = 14 + 14 + 8
    let tw = w - 12 - x0 - 8 - dw
    let title = Drawing.wrap(p.title ?? p.domain, f.rowTitle, t.ink, width: tw, max: 1)
    return WebLayout(
      shape: .compact, height: 32, image: nil, title: (title, CGPoint(x: x0, y: (32 - 12.5 * 1.3) / 2), f.rowTitle),
      desc: [], descAt: .zero, site: nil, fav: CGRect(x: 14, y: 9, width: 14, height: 14),
      domain: (Drawing.cut(p.domain, f.site, t.ink3, dw), CGPoint(x: w - 12 - dw, y: 16)))
  }
}

extension Drawing {
  /// Lines of `s` in `width`, at most `max`, the last cut with an ellipsis; breakAll: anywhere (a path)
  static func wrap(
    _ s: String, _ font: Font, _ color: CGColor, width: CGFloat, max: Int, breakAll: Bool = false
  ) -> [CTLine] {
    guard !s.isEmpty, width > 1 else { return [] }
    let attrs: [CFString: Any] = [kCTFontAttributeName: font.ct, kCTForegroundColorAttributeName: color]
    let a = CFAttributedStringCreate(nil, s as CFString, attrs as CFDictionary)!
    let ts = CTTypesetterCreateWithAttributedString(a)
    let n = CFAttributedStringGetLength(a)
    var out: [CTLine] = []
    var at = 0
    while at < n, out.count < max {
      if out.count == max - 1 {
        // as -webkit-line-clamp: the last line breaks where it would, and "…" follows it when more text does
        var k =
          breakAll
          ? CTTypesetterSuggestClusterBreak(ts, at, Double(width)) : CTTypesetterSuggestLineBreak(ts, at, Double(width))
        if k <= 0 { k = 1 }
        guard at + k < n else {
          out.append(CTTypesetterCreateLine(ts, CFRange(location: at, length: n - at)))
          break
        }
        let head = (s as NSString).substring(with: NSRange(location: at, length: k))
        let line = CTLineCreateWithAttributedString(
          CFAttributedStringCreate(
            nil, (head.trimmingCharacters(in: .whitespaces) + "…") as CFString, attrs as CFDictionary))
        if CTLineGetTypographicBounds(line, nil, nil, nil) > width + 0.5 {
          let dots = CTLineCreateWithAttributedString(
            CFAttributedStringCreate(nil, "…" as CFString, attrs as CFDictionary))
          out.append(CTLineCreateTruncatedLine(line, width, .end, dots) ?? line)
        } else {
          out.append(line)
        }
        break
      }
      var k =
        breakAll
        ? CTTypesetterSuggestClusterBreak(ts, at, Double(width))
        : CTTypesetterSuggestLineBreak(ts, at, Double(width))
      if k <= 0 { k = 1 }
      out.append(CTTypesetterCreateLine(ts, CFRange(location: at, length: k)))
      at += k
    }
    return out
  }

  /// One line cut to `width` with an ellipsis
  static func cut(_ s: String, _ font: Font, _ color: CGColor, _ width: CGFloat) -> CTLine {
    let attrs: [CFString: Any] = [kCTFontAttributeName: font.ct, kCTForegroundColorAttributeName: color]
    let l = CTLineCreateWithAttributedString(CFAttributedStringCreate(nil, s as CFString, attrs as CFDictionary))
    guard CTLineGetTypographicBounds(l, nil, nil, nil) > width + 0.5 else { return l }
    let dots = CTLineCreateWithAttributedString(CFAttributedStringCreate(nil, "…" as CFString, attrs as CFDictionary))
    return CTLineCreateTruncatedLine(l, width, .end, dots) ?? l
  }

  /// Lines drawn from `at` (their tops), `lh` apart
  static func draw(_ ctx: CGContext, _ lines: [CTLine], at: CGPoint, lineHeight lh: CGFloat, _ font: Font) {
    let f = font.ct
    let ascent = CTFontGetAscent(f)
    let descent = CTFontGetDescent(f)
    for (i, l) in lines.enumerated() {
      let mid = at.y + CGFloat(i) * lh + lh / 2
      ctx.textPosition = CGPoint(x: at.x, y: mid + (ascent - descent) / 2)
      CTLineDraw(l, ctx)
    }
  }

  /// A page's icon (14, or 24 big), or its domain's initial on a pale square when it has none
  static func favicon(
    _ ctx: CGContext, _ p: Page, _ r: CGRect, big: Bool, _ t: Theme, images: DecodeCache, scale: CGFloat
  ) -> Int {
    let radius: CGFloat = big ? 8.5 : 4
    if let u = p.icon, !Task.isCancelled {
      let got = images.image(u, frame: 0, width: Int((r.width * scale).rounded(.up)), fileSize: p.iconSize)
      if let img = got.image {
        ctx.saveGState()
        ctx.addPath(CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil))
        ctx.clip()
        ctx.interpolationQuality = .high
        drawContained(ctx, img, in: r)
        ctx.restoreGState()
        return got.decoded ? 1 : 0
      }
    }
    let f = WebFonts(t)
    ctx.addPath(CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil))
    ctx.setFillColor(t.hlrow)
    ctx.fillPath()
    ctx.addPath(
      CGPath(roundedRect: r.insetBy(dx: 0.25, dy: 0.25), cornerWidth: radius, cornerHeight: radius, transform: nil))
    ctx.setStrokeColor(t.hair)
    ctx.setLineWidth(0.5)
    ctx.strokePath()
    let ch = String(p.domain.first ?? "?").uppercased()
    let font = big ? f.initialBig : f.initial
    let w = width(ch, font)
    text(ctx, ch, font, t.ink2, x: r.midX - w / 2, midY: r.midY, width: .infinity)
    return 0
  }

  /// A picture as large as fits in `r`, in its middle (object-fit: contain), y-down
  static func drawContained(_ ctx: CGContext, _ img: CGImage, in r: CGRect) {
    let iw = CGFloat(img.width)
    let ih = CGFloat(img.height)
    guard iw > 0, ih > 0 else { return }
    let k = min(r.width / iw, r.height / ih)
    let d = CGRect(x: r.midX - iw * k / 2, y: r.midY - ih * k / 2, width: iw * k, height: ih * k)
    ctx.saveGState()
    ctx.translateBy(x: 0, y: d.maxY + d.minY)
    ctx.scaleBy(x: 1, y: -1)
    ctx.draw(img, in: d)
    ctx.restoreGState()
  }

  /// A bookmark (a Web card's body, a Link List's rich row) in `r`
  static func bookmark(
    _ ctx: CGContext, _ p: Page, _ b: WebLayout, in r: CGRect, loading: Bool, small: Bool, _ t: Theme,
    images: DecodeCache, scale: CGFloat
  ) -> Int {
    let f = WebFonts(t)
    var decodes = 0
    ctx.saveGState()
    ctx.translateBy(x: r.minX, y: r.minY)
    defer { ctx.restoreGState() }
    let titleLH = small ? 13 * 1.4 : WebLayout.titleLine
    if var ir = b.image {
      if b.shape == .side && !small { ir.size.height = r.height }
      ctx.saveGState()
      if small {
        ctx.addPath(CGPath(roundedRect: ir, cornerWidth: 7, cornerHeight: 7, transform: nil))
        ctx.clip()
      }
      ctx.setFillColor(t.hlrow)
      ctx.fill(ir)
      if let u = p.image, !Task.isCancelled {
        let got = images.image(u, frame: 0, width: Int((ir.width * scale).rounded(.up)), fileSize: p.imageSize)
        if got.decoded { decodes += 1 }
        if let img = got.image {
          ctx.interpolationQuality = .high
          drawContained(ctx, img, in: ir)
        }
      }
      ctx.restoreGState()
      if small {
        ctx.addPath(
          CGPath(roundedRect: ir.insetBy(dx: -0.25, dy: -0.25), cornerWidth: 7, cornerHeight: 7, transform: nil))
        ctx.setStrokeColor(t.hair)
        ctx.setLineWidth(0.5)
        ctx.strokePath()
      } else {
        ctx.setFillColor(t.line)
        if b.shape == .banner {
          ctx.fill(CGRect(x: 0, y: ir.maxY, width: ir.width, height: 1))
        } else {
          ctx.fill(CGRect(x: ir.minX, y: 0, width: 1, height: r.height))
        }
      }
    }
    switch b.shape {
    case .compact:
      decodes += favicon(ctx, p, b.fav, big: false, t, images: images, scale: scale)
      draw(ctx, b.title.lines, at: b.title.at, lineHeight: titleLH, b.title.font)
      if let d = b.domain {
        ctx.textPosition = CGPoint(
          x: d.at.x, y: d.at.y + (CTFontGetAscent(f.site.ct) - CTFontGetDescent(f.site.ct)) / 2)
        CTLineDraw(d.line, ctx)
      }
    case .none:
      decodes += favicon(ctx, p, b.fav, big: !small, t, images: images, scale: scale)
      draw(ctx, b.title.lines, at: b.title.at, lineHeight: titleLH, b.title.font)
      draw(ctx, b.path, at: b.pathAt, lineHeight: WebLayout.pathLine, f.path)
      if let a = b.actsAt {
        if loading {
          text(ctx, "Fetching preview…", f.site, t.ink3, x: a.x, midY: a.y + 8, width: r.width - 28)
        } else {
          var x = a.x
          text(ctx, "↻ Retry", f.site, t.ink2, x: x + 2, midY: a.y + 8, width: .infinity)
          x += width("↻ Retry", f.site) + 8 + 4
          text(ctx, "·", f.site, t.ink3, x: x, midY: a.y + 8, width: .infinity)
          x += width("·", f.site) + 4
          text(ctx, "✎ Edit Title", f.site, t.ink2, x: x + 2, midY: a.y + 8, width: .infinity)
        }
      }
    case .banner, .side, .text:
      draw(ctx, b.title.lines, at: b.title.at, lineHeight: titleLH, b.title.font)
      draw(ctx, b.desc, at: b.descAt, lineHeight: WebLayout.descLine, f.desc)
      if let s = b.site {
        decodes += favicon(ctx, p, b.fav, big: false, t, images: images, scale: scale)
        let x = s.x + 14 + 6
        let mainRight = b.image.map { b.shape == .side && !small ? $0.minX : r.width } ?? r.width
        text(
          ctx, p.siteText, f.site, t.ink3, x: x, midY: s.y + WebLayout.siteLine / 2,
          width: max(0, (small ? (b.image?.minX ?? r.width) - 12 : mainRight) - 14 - x))
      }
    }
    return decodes
  }

  /// A Web card: its paper, its bookmark clipped to the card's corners
  static func web(_ ctx: CGContext, _ w: Web, _ r: CGRect, _ t: Theme, images: DecodeCache, scale: CGFloat) -> Int {
    paper(ctx, r, t, id: w.id, rule: nil)
    let b = WebLayout.of(w.page, style: w.style, width: r.width, small: false, loading: w.loading, t)
    ctx.saveGState()
    ctx.addPath(squircle(r, 12.5))
    ctx.clip()
    let n = bookmark(ctx, w.page, b, in: r, loading: w.loading, small: false, t, images: images, scale: scale)
    ctx.restoreGState()
    edge(ctx, r, t)
    return n
  }

  /// A Link List: its header (the link icon, its title, how many rows) and its rows, a line between each
  static func links(_ ctx: CGContext, _ l: Links, _ r: CGRect, _ t: Theme, images: DecodeCache, scale: CGFloat) -> Int {
    paper(ctx, r, t, id: l.id, rule: true)
    let f = WebFonts(t)
    let ink = t.id == .inkWash
    var x: CGFloat = ink ? 14 : 10
    let mid = t.headerHeight / 2
    if !ink {
      ctx.saveGState()
      ctx.translateBy(x: x, y: mid - 6.5)
      ctx.scaleBy(x: 13 / 16, y: 13 / 16)
      ctx.addPath(SVGPath.parse(WebIcons.link))
      ctx.setStrokeColor(t.ink2)
      ctx.setLineWidth(1.4)
      ctx.setLineCap(.round)
      ctx.setLineJoin(.round)
      ctx.strokePath()
      ctx.restoreGState()
      x += 13 + 7
    }
    let count = "\(l.rows.count)"
    let cw = width(count, f.count) + 12
    let tw = min(width(l.title, f.header) + 1, r.width - x - cw - 9 - 36)
    text(ctx, l.title, f.header, t.ink, x: x, midY: mid, width: tw)
    x += tw + (ink ? 9 : 7)
    let badge = CGRect(x: x, y: mid - 8.25, width: cw, height: 16.5)
    ctx.addPath(CGPath(roundedRect: badge, cornerWidth: 7, cornerHeight: 7, transform: nil))
    ctx.setFillColor(t.hlrow)
    ctx.fillPath()
    text(ctx, count, f.count, t.ink3, x: badge.minX + 6, midY: mid, width: .infinity)
    let lay = LinksLayout.of(l, width: r.width, t)
    var decodes = 0
    for (i, row) in l.rows.enumerated() where i < lay.rows.count {
      let rr = lay.rows[i].rect
      if let b = lay.rows[i].rich {
        decodes += bookmark(
          ctx, row.page, b, in: CGRect(x: 0, y: rr.minY, width: rr.width, height: b.height), loading: false,
          small: true,
          t, images: images, scale: scale)
      } else if let c = lay.rows[i].compact {
        decodes += bookmark(ctx, row.page, c, in: rr, loading: false, small: false, t, images: images, scale: scale)
      }
      if i < l.rows.count - 1 {
        ctx.setFillColor(t.line)
        ctx.fill(CGRect(x: 0, y: rr.maxY, width: r.width, height: 1))
      }
    }
    edge(ctx, r, t)
    return decodes
  }
}

enum WebIcons {
  /// icons.tsx link
  static let link =
    "M6.67 8.67a3.33 3.33 0 0 0 5.03.36l2-2a3.33 3.33 0 0 0-4.71-4.71L7.84 3.46M9.33 7.33a3.33 3.33 0 0 0-5.03-.36l-2 2a3.33 3.33 0 0 0 4.71 4.71l1.14-1.14"
}
