import AppKit
import CodeBoardModel
import CodeUI
import CoreText

// The calls on a code card's lines (core render.ts's .call spans): drawn into the card's picture with a dotted underline
// in the function colour (styles.css .call), found under the pointer by the same text layout. Which calls a segment
// has is the shell's (its analysis of the segment's file at the segment's version): a segment whose source is not on
// this Mac has none. The provider is asked on the main thread before a scene is made, and again when it says its
// calls changed.

/// A call on a line of a segment (core lines.ts's call): its line, where its name starts and ends (UTF-16 columns of
/// the line), its name and receiver; dispatch: the name forwarded by string (call("run", …))
public struct CallSpan: Equatable, Sendable {
  public var line: Int
  public var col: Int
  public var end: Int
  public var name: String
  public var recv: String?
  public var dispatch: String?

  public init(line: Int, col: Int, end: Int, name: String, recv: String? = nil, dispatch: String? = nil) {
    self.line = line
    self.col = col
    self.end = end
    self.name = name
    self.recv = recv
    self.dispatch = dispatch
  }
}

/// What the board asks the shell about the calls on its code cards
@MainActor public protocol CallHost: AnyObject {
  /// The calls on a segment's lines; nil while not known, or when its source is not here (no marks)
  func calls(_ s: Segment) -> [CallSpan]?
  /// Told when calls it had not known come: the board asks again
  var onCallsChanged: (() -> Void)? { get set }
}

/// A call under the pointer: on which card, segment and line, and where it is drawn (board units)
struct CallAt: Equatable {
  var card: CardID
  var segment: Segment
  var call: CallSpan
  var rect: CGRect
}

extension CanvasView {
  /// What the provider says of the calls on a board's code cards, for its scene (made off the main thread). A shared
  /// card's content is read in on an open board (BoardDocument): asked as a card of its own is; one whose file could
  /// not be read has none to ask of
  func callInfo(_ b: Board) -> [SegmentID: [CallSpan]] { Self.callInfo(b, callHost) }

  static func callInfo(_ b: Board, _ host: CallHost?) -> [SegmentID: [CallSpan]] {
    guard let host else { return [:] }
    var out: [SegmentID: [CallSpan]] = [:]
    for c in b.cards {
      guard case .own(let k) = c.content, case .code(let code) = k.body else { continue }
      for s in code.segments where s.source != nil && out[s.id] == nil {
        if let calls = host.calls(s), !calls.isEmpty { out[s.id] = calls }
      }
    }
    return out
  }

  /// The provider learnt calls it had not known: the cards are drawn again with them
  func callsChanged() { refresh() }

  /// The call drawn under a board point, on a code card at rest
  func callAt(_ p: CGPoint) -> CallAt? {
    guard let id = hitCard(p), let s = scene, let placed = s.placed[id], let c = placed.code, !placed.folded,
      let i = index(of: .card(id)), case .code(let d) = s.items[i].drawing
    else { return nil }
    let top = placed.rect.minY + c.top
    let font = theme.codeStyle.font
    for row in c.layout.rows {
      guard case .line(let si, let n?, let text, _) = row.row, si < d.calls.count,
        p.y >= top + row.y, p.y < top + row.y + row.height
      else { continue }
      let x0 = placed.rect.minX + c.layout.gutter + c.layout.shift
      for call in d.calls[si] where call.line == n {
        guard let r = Drawing.callBox(call, text: text, font: font, x: x0, y: top + row.y, height: row.height),
          r.minX <= p.x, p.x < r.maxX, let seg = segment(of: id, at: si)
        else { continue }
        return CallAt(card: id, segment: seg, call: call, rect: r)
      }
      return nil
    }
    return nil
  }

  /// A code card's segment by its index
  private func segment(of id: CardID, at index: Int) -> Segment? {
    guard case .own(let k)? = document?.board.card(id)?.content, case .code(let code) = k.body,
      index < code.segments.count
    else { return nil }
    return code.segments[index]
  }
}

extension Drawing {
  /// Where a call's name is drawn on its row: its columns as the code is laid out (tabs and all), the row's height;
  /// nil when the row does not hold it (the rest of a wrapped line)
  static func callBox(_ c: CallSpan, text: String, font: CodeFont, x: CGFloat, y: CGFloat, height: CGFloat) -> CGRect? {
    let n = text.utf16.count
    guard c.col >= 0, c.end > c.col, c.end <= n else { return nil }
    let line = CodeDraw.line(text, font)
    let a = CTLineGetOffsetForStringIndex(line, c.col, nil)
    let b = CTLineGetOffsetForStringIndex(line, c.end, nil)
    return CGRect(x: x + a, y: y, width: b - a, height: height)
  }

  /// The calls of a code card's lines, each a dotted underline 3 below the text in the function colour at 60 %
  /// (styles.css .call: underline dotted color-mix(var(--k-fn) 60%), text-underline-offset 3px)
  static func callMarks(_ ctx: CGContext, _ c: Code, _ t: Theme) {
    guard !c.calls.isEmpty else { return }
    let l = c.layout
    let font = t.codeStyle.font
    let fn = t.syntax[.function] ?? t.ink
    ctx.saveGState()
    ctx.setStrokeColor(fn.copy(alpha: fn.alpha * 0.6) ?? fn)
    ctx.setLineWidth(1)
    ctx.setLineDash(phase: 0, lengths: [1, 2])
    let ascent = CTFontGetAscent(font.ct)
    let descent = CTFontGetDescent(font.ct)
    for p in l.rows {
      guard case .line(let si, let n?, let text, _) = p.row, si < c.calls.count else { continue }
      for call in c.calls[si] where call.line == n {
        guard let r = callBox(call, text: text, font: font, x: l.gutter + l.shift, y: p.y, height: p.height)
        else { continue }
        // 3 under the baseline, which CodeDraw.line puts (ascent − descent) / 2 below the row's middle
        let base = (p.y + p.height / 2 + (ascent - descent) / 2 + 3).rounded() - 0.5
        ctx.move(to: CGPoint(x: r.minX, y: base))
        ctx.addLine(to: CGPoint(x: r.maxX, y: base))
      }
    }
    ctx.strokePath()
    ctx.restoreGState()
  }
}
