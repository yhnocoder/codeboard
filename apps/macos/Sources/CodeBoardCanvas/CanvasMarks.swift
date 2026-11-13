import AppKit
import CodeBoardModel
import CodeBoardNotes

// Sidenote markers (the web board's ui/SnBadge.tsx and the code card's gutter badge, cards/CodeBody.tsx): one round
// marker per spot with sidenotes, the count, or an amber ? while a question there is open. A whole card's sits just past
// its right edge, level with its header; a Note block's there too, level with the block's first line; a Highlight's in
// the line numbers; a Section's after its title; a free one on the board, centred on its point. They are layers in the
// card's (or the title's) own layer, so they move with it and need no redraw; their places depend on the zoom at rest
// (the strip past a card's edge clears the arrow ports, which grow zoomed out), worked out again when the camera rests.

/// What a sidenote popup shows: the sidenotes at a spot, or on a Highlight's lines
public enum PopAt: Hashable, Sendable {
  case spot(Spot)
  case lines(Lines)
}

struct Mark {
  var at: PopAt
  var notes: [SidenoteID]
  /// A question there is still open
  var ask: Bool
  /// The item it is drawn in (a card, a Section's title); nil: on the board
  var owner: Scene.Owner?
  /// Its badge, in the owner's units from its top left (or on the board)
  var frame: CGRect
  /// Where it takes the pointer, on the board
  var hit: CGRect
  var gutter: Bool
}

extension CanvasView {
  /// A marker as drawn, board units: 14 across (13 in the line numbers), like the rest of the card
  static let markSize: CGFloat = 14
  static let gutterMarkSize: CGFloat = 13

  /// Its invisible hit area at the zoom at rest: at least 18 px on screen, and never under 18 board units
  var markHit: CGFloat { max(18, 18 / camera.zoom) }

  /// How far past a card's right edge the strip of markers starts: clear of the arrow ports on the edge (drawn bigger
  /// zoomed out, portRadius) by 5 px on screen (SnBadge.tsx stripGap)
  var stripGap: CGFloat {
    let z = camera.zoom
    return 4.5 * sqrt(max(1, 1 / z)) + 5 / z
  }

  /// The markers for the board shown, where they are at the zoom now
  func computeMarks() -> [Mark] {
    guard let scene else { return [] }
    let t = theme
    var out: [Mark] = []
    var titles: [SectionID: CGRect] = [:]
    var cardRects: [CardID: CGRect] = [:]
    for it in scene.items {
      switch it.owner {
      case .sectionTitle(let s)?: titles[s] = it.rect
      case .card(let c)?: cardRects[c] = it.rect
      default: break
      }
    }
    let gap = stripGap
    let hit = markHit
    // one per spot, in the board's order
    var spots: [Spot] = []
    var bySpot: [Spot: [Sidenote]] = [:]
    for n in scene.notes {
      guard let s = n.anchor.spot else { continue }
      if bySpot[s] == nil { spots.append(s) }
      bySpot[s, default: []].append(n)
    }
    // a free spot whose popup is open with nothing written yet shows its marker too, empty
    if case .spot(let s)? = openPop, case .point = s, bySpot[s] == nil {
      spots.append(s)
      bySpot[s] = []
    }
    func badge(_ notes: [Sidenote]) -> CGFloat {
      let text = notes.contains(where: \.isOpenQuestion) ? "?" : notes.isEmpty ? "" : "\(notes.count)"
      return max(Self.markSize, (Drawing.width(text, Self.markFont(gutter: false)) + 8).rounded(.up))
    }
    for s in spots {
      let notes = bySpot[s] ?? []
      let w = badge(notes)
      let ask = notes.contains(where: \.isOpenQuestion)
      var owner: Scene.Owner?
      var frame: CGRect
      var origin = CGPoint.zero
      switch s {
      case .card(let c), .block(let c, _):
        guard let r = cardRects[c], let p = scene.placed[c], !p.folded else { continue }
        var y = (scene.parts[c].map { Self.hasHeader($0.content) } ?? true ? t.headerHeight / 2 : 16)
        if case .block(_, let ref) = s {
          guard let bs = p.blocks, let k = ref.at(bs.map(\.sig)) ?? (ref.index < bs.count ? ref.index : nil),
            bs[k].h > 0
          else { continue }
          y = CGFloat(bs[k].y + bs[k].line / 2)
        }
        owner = .card(c)
        origin = r.origin
        frame = CGRect(x: r.width + gap, y: y - Self.markSize / 2, width: w, height: Self.markSize)
      case .section(let id):
        if let r = titles[id] {
          owner = .sectionTitle(id)
          origin = r.origin
          frame = CGRect(x: r.width + 6, y: (r.height - Self.markSize) / 2, width: w, height: Self.markSize)
        } else if let f = scene.frames.first(where: { $0.id == id }) {
          let at = CGPoint(x: f.rect.minX + t.sectionTitleAt.x, y: f.rect.minY + t.sectionTitleAt.y)
          frame = CGRect(x: at.x, y: at.y + (t.sectionTitleHeight - Self.markSize) / 2, width: w, height: Self.markSize)
        } else {
          continue
        }
      case .point(let x, let y):
        frame = CGRect(x: x - w / 2, y: y - Self.markSize / 2, width: w, height: Self.markSize)
      }
      let onBoard = frame.offsetBy(dx: origin.x, dy: origin.y)
      out.append(
        Mark(
          at: .spot(s), notes: notes.map(\.id), ask: ask, owner: owner, frame: frame,
          hit: onBoard.insetBy(dx: min(0, (onBoard.width - hit) / 2), dy: (onBoard.height - hit) / 2), gutter: false))
    }
    // a Highlight with sidenotes on it: its count in the line numbers, level with its first line shown
    for (c, part) in scene.parts {
      guard let code = part.code, let r = cardRects[c], case .code(let card) = part.content.body else { continue }
      for (si, seg) in card.segments.enumerated() {
        for h in seg.highlights {
          let l = Lines(card: c, segment: seg.id, range: h)
          let notes = scene.notes.filter { n in
            guard let m = n.anchor.lines else { return false }
            return m.card == c && m.segment == seg.id && h.contains(m.range.lowerBound)
              && h.contains(m.range.upperBound)
          }
          guard !notes.isEmpty, let row = h.lazy.compactMap({ code.layout.row(segment: si, line: $0) }).first else {
            continue
          }
          let ask = notes.contains(where: \.isOpenQuestion)
          let text = ask ? "?" : "\(notes.count)"
          let w = max(Self.gutterMarkSize, (Drawing.width(text, Self.markFont(gutter: true)) + 7).rounded(.up))
          let frame = CGRect(
            x: code.layout.gutter - 6 - w, y: code.top + row.y + 3.5, width: w, height: Self.gutterMarkSize)
          let onBoard = frame.offsetBy(dx: r.minX, dy: r.minY)
          // as tall as a line at most, so the next line's keeps its own; it grows rightward from the badge's left edge
          let hh = min(hit, max(17, min(row.height, 20)))
          out.append(
            Mark(
              at: .lines(l), notes: notes.map(\.id), ask: ask, owner: .card(c), frame: frame,
              hit: CGRect(
                x: onBoard.minX, y: onBoard.midY - hh / 2, width: max(onBoard.width, hit), height: hh),
              gutter: true))
        }
      }
    }
    return out
  }

  /// Whether a card of this content draws a header its whole-card marker sits level with (else 16 from its top)
  static func hasHeader(_ c: CardContent) -> Bool {
    switch c.body {
    case .code(let code): code.framed
    case .note: true
    case .image(let img): img.framed
    default: false
    }
  }

  static func markFont(gutter: Bool) -> Font { Font(NSFont.systemFont(ofSize: 9, weight: .semibold)) }

  /// The markers laid out again (the board changed, the camera came to rest at another zoom, a popup opened)
  func placeMarks() {
    guard let scene else { return }
    marks = computeMarks()
    marksZoom = camera.zoom
    var boxes: [Scene.Owner: CALayer] = [:]
    for (i, it) in scene.items.enumerated() where i < items.count {
      if let o = it.owner { boxes[o] = items[i].box }
    }
    withoutAnimation {
      for l in markLayers { l.removeFromSuperlayer() }
      markLayers = marks.enumerated().map { i, m in
        let l = markLayer(m, hovered: i == hoveredMark)
        (m.owner.flatMap { boxes[$0] } ?? freeMarks).addSublayer(l)
        return l
      }
    }
  }

  /// A marker's layer: its round badge, the count or ? on it
  func markLayer(_ m: Mark, hovered: Bool) -> CALayer {
    let l = CALayer()
    l.name = "mark"
    l.frame = m.frame
    l.zPosition = 5
    paintMark(l, m, hovered: hovered)
    return l
  }

  func paintMark(_ l: CALayer, _ m: Mark, hovered: Bool) {
    let t = theme
    let open = openPop == m.at
    let text = m.ask ? "?" : m.notes.isEmpty ? "" : "\(m.notes.count)"
    var bg: CGColor
    var ink: CGColor
    if m.gutter {
      // .hx-band .hxm: the accent on a tint of it, filled while open or hovered; an open question's in amber
      if m.ask {
        bg = hovered || open ? Self.mix(t.ask, 0.82, t.ink) : t.ask
        ink = t.askInk
      } else if hovered || open {
        bg = t.accent
        ink = t.accentInk
      } else {
        bg = Self.mix(t.accent, 0.14, t.surface)
        ink = t.accent
      }
    } else if m.ask {
      bg = hovered ? Self.mix(t.ask, 0.82, t.ink) : t.ask
      ink = t.askInk
    } else if hovered {
      bg = t.accent
      ink = t.accentInk
    } else {
      bg = t.mark
      ink = t.markInk
    }
    l.backgroundColor = bg
    l.cornerRadius = l.bounds.height / 2
    l.borderWidth = 0
    l.shadowOpacity = 0
    if case .spot(.point) = m.at {
      // free on the board: a soft shadow; one with nothing in it yet (its popup open) is an empty ring
      l.shadowColor = CGColor(gray: 0, alpha: 1)
      l.shadowOpacity = m.notes.isEmpty ? 0.2 : 0.25
      l.shadowRadius = 2
      l.shadowOffset = CGSize(width: 0, height: 1)
      if m.notes.isEmpty {
        l.backgroundColor = t.surface
        l.borderColor = t.ask
        l.borderWidth = 1.5
      }
    }
    let scale = backing * max(1, camera.zoom)
    let size = l.bounds.size
    let font = Self.markFont(gutter: m.gutter)
    l.contents =
      text.isEmpty
      ? nil
      : CanvasView.picture(size: size, scale: scale) { ctx in
        let w = Drawing.width(text, font)
        Drawing.text(ctx, text, font, ink, x: (size.width - w) / 2, midY: size.height / 2, width: .infinity)
      }
    l.contentsScale = scale
  }

  /// a mixed with b, `k` of a (CSS color-mix in sRGB)
  static func mix(_ a: CGColor, _ k: CGFloat, _ b: CGColor) -> CGColor {
    let ca = a.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil)?.components
    let cb = b.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil)?.components
    guard let ca, let cb, ca.count >= 3, cb.count >= 3 else { return a }
    let alpha = (ca.last ?? 1) * k + (cb.last ?? 1) * (1 - k)
    return CGColor(
      srgbRed: ca[0] * k + cb[0] * (1 - k), green: ca[1] * k + cb[1] * (1 - k), blue: ca[2] * k + cb[2] * (1 - k),
      alpha: alpha)
  }

  /// The marker under a board point (its hit area), the last drawn first
  func markAt(_ p: CGPoint) -> Int? {
    marks.indices.last { marks[$0].hit.contains(p) }
  }

  /// The pointer over a marker: it lights up
  func hoverMark(_ i: Int?) {
    guard i != hoveredMark else { return }
    let was = hoveredMark
    hoveredMark = i
    withoutAnimation {
      for k in [was, i].compactMap({ $0 }) where k < marks.count && k < markLayers.count {
        paintMark(markLayers[k], marks[k], hovered: k == i)
      }
    }
  }
}

extension CanvasView {
  /// A marker clicked: its popup opens, or closes when it is open (hover never opens one)
  func togglePop(_ at: PopAt) {
    openPop(openPop == at ? nil : at)
  }

  /// The popup shown for `at`, or none
  func openPop(_ at: PopAt?) {
    guard openPop != at else { return }
    openPop = at
    placeMarks()
    onPop?(at)
  }
}
