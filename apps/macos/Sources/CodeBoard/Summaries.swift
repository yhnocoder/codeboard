// The zoomed-out summary level (core summary.ts; on the web the board's state/summary.ts and canvas/Summaries.tsx): below
// the board's cut the cards give way to one summary per innermost Section and per loose card, laid out by core's
// layoutSummaries (the session's `summaries`: each column with its title and text). Each column is a bitmap drawn on the
// raster queue at the cut's scale (the level is only ever seen below the cut). The detent at the cut and the switch under the
// mist run core's rules (canvas/detent.ts) through Ink's context, so a zoom stops, pushes, drains and switches as the web does.
import AppKit

struct SumScene: Decodable {
  struct Col: Decodable {
    struct Code: Decodable {
      var name: String
      var at: String
    }
    var key: String
    var x, y, w, h, hd: Double
    var title: String
    var text: String
    var head: Int?
    var kick: String?
    var code: Code?
  }
  var S, P, cut: Double
  var cols: [Col]
}

/** What the canvas draws for the detent and the switch (core Detent) */
struct Detent: Decodable {
  var mist: Double
  var line: Double
  var seal: Bool
  var to: Int
  static let rest = Detent(mist: 0, line: 0, seal: false, to: 1)
}

final class SummaryLevel {
  /** In the world, under the cards' layer; hidden at the card level */
  let layer = CALayer()
  private var cols: [String: CALayer] = [:]
  private(set) var scene: SumScene?
  var cut: Double { scene?.cut ?? 0 }
  init() {
    layer.anchorPoint = .zero
    layer.isHidden = true
  }

  /** A new layout: columns drawn again where their text, size or the look changed */
  func apply(_ s: SumScene, backing: CGFloat) {
    scene = s
    let keep = Set(s.cols.map(\.key))
    for (k, l) in cols where !keep.contains(k) {
      l.removeFromSuperlayer()
      cols[k] = nil
    }
    let scale = max(0.1, s.cut) * backing
    for c in s.cols {
      let l = cols[c.key] ?? {
        let l = CALayer()
        l.anchorPoint = .zero
        l.contentsGravity = .topLeft
        cols[c.key] = l
        layer.addSublayer(l)
        return l
      }()
      l.frame = CGRect(x: c.x, y: c.y, width: c.w, height: c.h)
      let sig = "\(c.title)\u{1}\(c.text)\u{1}\(c.w)x\(c.h)\u{1}\(s.S)\u{1}\(Theme.look)\u{1}\(Theme.isDark)\u{1}\(scale)"
      if l.name == sig { continue }
      l.name = sig
      draw(c, S: s.S, P: s.P, scale: scale, into: l, sig: sig)
    }
  }

  /** The column's bitmap (styles.css .sumcol: padding P; .sumhdi 700 S×0.8 / 1.3 with the accent square before it, a Section
   *  header at S×1.12 underlined in the accent (h1) or S×0.92 dashed (h2); .sumkick 600 S×0.56 ink-3; .sumtx 400 S / 1.5 in
   *  --sum-grey, its bold runs in the ink). Text past the column's room is cut (the web fades its last lines) */
  private func draw(_ c: SumScene.Col, S: Double, P: Double, scale: CGFloat, into l: CALayer, sig: String) {
    let size = CGSize(width: c.w, height: c.h), appearance = Theme.appearance
    let ink = Theme.isInk
    CardLayer.queue.addOperation {
      let surface = CardLayer.surface(size, scale: scale) {
        appearance.performAsCurrentDrawingAppearance {
          // ponytail: --sum-hd / --sum-grey are the stylesheet's defaults (ink-2; ink-3 at 80 % over the bg), not the looks' own
          let hd = Theme.ink2, grey = Theme.ink3.blended(withFraction: 0.2, of: Theme.bg) ?? Theme.ink3
          let headFont = { (sz: CGFloat, w: NSFont.Weight) in ink ? Theme.serif(sz, weight: w) : Theme.sys(sz, weight: w) }
          let bodyFont = { (sz: CGFloat, bold: Bool) in ink ? Theme.serif(sz, weight: bold ? .bold : .regular) : Theme.sys(sz, weight: bold ? .bold : .regular) }
          var y = P
          let x = P, w = c.w - 2 * P
          if let kick = c.kick {
            let para = NSMutableParagraphStyle()
            para.lineHeightMultiple = 1.3
            let t = NSAttributedString(string: "\(kick) ›", attributes: [.font: headFont(S * 0.56, .semibold), .foregroundColor: Theme.ink3, .kern: S * 0.56 * 0.04, .paragraphStyle: para])
            let r = t.boundingRect(with: CGSize(width: w, height: 1e5), options: [.usesLineFragmentOrigin])
            t.draw(with: CGRect(x: x, y: y, width: w, height: r.height), options: [.usesLineFragmentOrigin])
            y += r.height + S * 0.56 * 0.2
          }
          // the title block: its row's height (hd) keeps columns of one row level
          let level = c.head ?? 0
          let tsz = level == 1 ? S * 1.12 : level == 2 ? S * 0.92 : S * 0.8
          let para = NSMutableParagraphStyle()
          para.lineHeightMultiple = 1.3
          let title = NSMutableAttributedString()
          if let code = c.code {
            title.append(NSAttributedString(string: code.name, attributes: [.font: Theme.mono(tsz), .foregroundColor: hd, .paragraphStyle: para]))
            if !code.at.isEmpty { title.append(NSAttributedString(string: "  \(code.at)", attributes: [.font: headFont(tsz * 0.8, .regular), .foregroundColor: Theme.ink3, .paragraphStyle: para])) }
          } else {
            title.append(NSAttributedString(string: c.title, attributes: [.font: headFont(tsz, .bold), .foregroundColor: level == 1 ? Theme.ink : hd, .kern: tsz * (level == 1 ? 0.03 : 0.04), .paragraphStyle: para]))
          }
          let sq = tsz * 0.55, gap = tsz * 0.45
          let tx = level > 0 || c.code != nil ? x : x + sq + gap
          let tr = title.boundingRect(with: CGSize(width: w - (tx - x), height: 1e5), options: [.usesLineFragmentOrigin])
          if level == 0 && c.code == nil && !c.title.isEmpty {
            Theme.accent.setFill()
            NSBezierPath(roundedRect: CGRect(x: x, y: y + tsz * 1.3 / 2 - sq / 2, width: sq, height: sq), xRadius: 1, yRadius: 1).fill()
          }
          title.draw(with: CGRect(x: tx, y: y, width: w - (tx - x), height: tr.height), options: [.usesLineFragmentOrigin])
          if level > 0 {
            let ly = y + tr.height + tsz * (level == 1 ? 0.16 : 0.12)
            let path = NSBezierPath()
            path.move(to: CGPoint(x: x, y: ly))
            path.line(to: CGPoint(x: x + w, y: ly))
            path.lineWidth = max(level == 1 ? 2 : 1, tsz * (level == 1 ? 0.045 : 0.03))
            if level == 2 { path.setLineDash([path.lineWidth * 3, path.lineWidth * 2], count: 2, phase: 0) }
            (level == 1 ? Theme.accent.withAlphaComponent(0.7) : Theme.ink.withAlphaComponent(0.3)).setStroke()
            path.stroke()
          }
          y += max(c.hd, tr.height) + S * (level == 1 ? 1.12 * 0.32 : level == 2 ? 0.92 * 0.3 : 0.3)
          // the body: Markdown's **bold** runs in the ink, the rest in the grey
          let bp = NSMutableParagraphStyle()
          bp.lineHeightMultiple = 1.5
          let body = NSMutableAttributedString()
          var bold = false
          for (i, part) in c.text.components(separatedBy: "**").enumerated() {
            if i > 0 { bold.toggle() }
            body.append(NSAttributedString(string: part, attributes: [.font: bodyFont(S, bold), .foregroundColor: bold ? Theme.ink : grey, .paragraphStyle: bp]))
          }
          guard let cg = NSGraphicsContext.current?.cgContext else { return }
          cg.saveGState()
          cg.clip(to: CGRect(x: 0, y: 0, width: c.w, height: c.h))
          body.draw(with: CGRect(x: x, y: y, width: w, height: max(0, c.h - y)), options: [.usesLineFragmentOrigin])
          cg.restoreGState()
        }
      }
      DispatchQueue.main.async {
        guard l.name == sig, let surface else { return }
        l.contents = surface
        l.contentsScale = scale
      }
    }
  }
}

/** The detent's and the switch's rules, from core through Ink's context */
enum DetentRules {
  static func levelFor(_ z: Double, _ cut: Double) -> Int { Int(Ink.rule("levelFor", [z, cut]).flatMap(Double.init) ?? 0) }
  static func towardCut(_ z0: Double, _ z: Double, _ cut: Double, _ shown: Int) -> Bool { Ink.rule("towardCut", [z0, z, cut, shown]) == "true" }
  static func pushStep(_ push: Double, _ z0: Double, _ z: Double) -> Double { Ink.rule("pushStep", [push, z0, z]).flatMap(Double.init) ?? push }
  static func pushed(_ q: Double, _ to: Int) -> Detent { Ink.rule("pushed", [q, to]).flatMap { try? decodeJSON(Detent.self, $0) } ?? .rest }
  static func drainStep(_ push: Double, _ dt: Double) -> Double { Ink.rule("drainStep", [push, dt]).flatMap(Double.init) ?? 0 }
  static func switching(_ t: Double, _ mist0: Double, _ to: Int) -> Detent { Ink.rule("switching", [t, mist0, to]).flatMap { try? decodeJSON(Detent.self, $0) } ?? .rest }
  static func acrossCut(_ cut: Double, _ to: Int) -> Double { Ink.rule("acrossCut", [cut, to]).flatMap(Double.init) ?? cut }
  struct Times: Decodable {
    var ms, cover, drainAfter: Double
  }
  static let times: Times = Ink.rule("detent", []).flatMap { try? decodeJSON(Times.self, $0) } ?? Times(ms: 520, cover: 0.42, drainAfter: 80)
}
