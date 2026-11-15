import AppKit
import CodeBoardCanvas

/// A check of a recording: its name, whether it held, what it found
struct Verdict {
  var check: String
  var ok: Bool
  var detail: String
}

/// Judges a recording as main's probes (packages/board/test/probes.ts) do, on what this app recorded: `jumped` (a
/// card's or Section's step more than 3 times both steps around it), `flash` (an 8-point cell of the picture that changed
/// for 1–3 frames and came back, where nothing moved and the camera stood still), then the scenario's own checks
struct Judge {
  let frames: [Driver.Frame]
  let scenario: Scenario

  func run() -> [Verdict] {
    [jumped(), flash()] + scenario.checks.map { $0(frames) }
  }

  /// Each item's place per frame (screen points), where it is drawn
  private func tracks() -> [String: [(Int, [Double])]] {
    var out: [String: [(Int, [Double])]] = [:]
    for f in frames {
      for (id, r) in f.canvas?.cards ?? [:] { out["card \(id)", default: []].append((f.n, r)) }
      for (id, r) in f.canvas?.sections ?? [:] { out["section \(id)", default: []].append((f.n, r)) }
    }
    return out
  }

  func jumped() -> Verdict {
    var hits: [String] = []
    for (id, track) in tracks() where track.count > 2 {
      func d(_ i: Int) -> Double {
        let (a, b) = (track[i - 1].1, track[i].1)
        return zip(a, b).map { abs($0 - $1) }.max() ?? 0
      }
      for i in 1..<track.count {
        let here = d(i)
        let before = i > 1 ? d(i - 1) : 0
        let after = i + 1 < track.count ? d(i + 1) : 0
        if here > 6, here > 3 * max(before, after) { hits.append("\(id) at frame \(track[i].0): \(Int(here)) pt") }
      }
    }
    return Verdict(
      check: "jumped", ok: hits.isEmpty, detail: hits.isEmpty ? "none" : hits.prefix(8).joined(separator: "; "))
  }

  func flash() -> Verdict {
    let cell = 16
    var grids: [(Int, [[UInt32]])] = []
    for f in frames {
      guard let name = f.image,
        let img = NSImage(contentsOf: scenario.folder.appending(path: name))?
          .cgImage(forProposedRect: nil, context: nil, hints: nil)
      else { continue }
      grids.append((f.n, Sheet.cells(img, cell: cell)))
    }
    guard grids.count > 4 else { return Verdict(check: "flash", ok: true, detail: "too few pictures") }
    let byN = Dictionary(frames.map { ($0.n, $0) }, uniquingKeysWith: { a, _ in a })
    func still(_ a: Int, _ b: Int) -> Bool {
      let cams = frames.filter { $0.n >= a && $0.n <= b }.compactMap { $0.canvas?.camera }
      return Set(cams.map { "\($0)" }).count <= 1
    }
    var hits: [String] = []
    for i in 1..<(grids.count - 1) {
      let (prev, cur) = (grids[i - 1].1, grids[i].1)
      for y in cur.indices {
        for x in cur[y].indices where differs(prev[y][x], cur[y][x]) {
          // back as it was within 3 frames, and staying so
          guard
            let back = (1...3).first(where: { k in
              i + k + 1 < grids.count && !differs(prev[y][x], grids[i + k].1[y][x])
                && !differs(prev[y][x], grids[i + k + 1].1[y][x])
            })
          else { continue }
          let (a, b) = (grids[i - 1].0, grids[i + back].0)
          guard still(a, b), !moving(at: CGPoint(x: x * cell / 2, y: y * cell / 2), from: a, to: b, byN) else {
            continue
          }
          hits.append("frame \(grids[i].0) at (\(x * cell / 2), \(y * cell / 2)) for \(back)")
        }
      }
    }
    return Verdict(
      check: "flash", ok: hits.isEmpty,
      detail: hits.isEmpty ? "none" : "\(hits.count): " + hits.prefix(6).joined(separator: "; "))
  }

  private func differs(_ a: UInt32, _ b: UInt32) -> Bool {
    (0..<4).contains { k in abs(Int((a >> (k * 8)) & 0xff) - Int((b >> (k * 8)) & 0xff)) > 24 }
  }

  /// Whether a window point (top-left origin) is under something that moved between frames a and b (24 points around)
  private func moving(at p: CGPoint, from a: Int, to b: Int, _ byN: [Int: Driver.Frame]) -> Bool {
    guard let fa = byN[a]?.canvas, let fb = byN[b]?.canvas, let o = byN[a]?.origin else { return false }
    let p = CGPoint(x: p.x - o[0], y: p.y - o[1])
    for (id, r) in fa.cards
    where fb.cards[id] != r || frames.contains(where: { $0.n > a && $0.n < b && $0.canvas?.cards[id] != r }) {
      if CGRect(x: r[0], y: r[1], width: r[2], height: r[3]).insetBy(dx: -24, dy: -24).contains(p) { return true }
    }
    return false
  }
}
