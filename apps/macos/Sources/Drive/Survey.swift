import AppKit
import CodeBoardCanvas
import CodeBoardModel

/// `Drive survey <vault>`: opens every board of a vault (a copy: nothing is written) in a canvas of the main window's
/// size and prints, as counts only, how the boards open: the zoom they open at against their summary cut
@MainActor enum Survey {
  static func run(_ root: URL, size: CGSize) async {
    let vault = Vault(root: root)
    guard let tree = try? vault.tree() else {
      print("no vault at \(root.path(percentEncoded: false))")
      return
    }
    let canvas = CanvasView(frame: CGRect(origin: .zero, size: size))
    var rows: [(zoom: Double, cut: Double, cards: Int)] = []
    var times: [Double] = []
    for b in tree.allBoards {
      guard
        let doc = try? BoardDocument(file: { vault.url(of: b.path).appending(path: Vault.boardFileName) })
      else { continue }
      let t0 = CACurrentMediaTime()
      guard (try? await canvas.show(doc, at: b, in: vault, theme: .warmInk)) != nil else { continue }
      times.append(CACurrentMediaTime() - t0)
      print(String(format: "board %d: %.2f s, %d cards", times.count, times.last!, doc.board.cards.count))
      rows.append((Double(canvas.currentCamera.zoom), Double(canvas.summaryCut), doc.board.cards.count))
    }
    let below = rows.filter { $0.cut > 0 && $0.zoom < $0.cut }
    print("boards: \(rows.count), opening below their cut (summaries): \(below.count)")
    func bucket(_ z: Double) -> String {
      switch z {
      case ..<0.1: "< 10 %"
      case ..<0.2: "10–20 %"
      case ..<0.3: "20–30 %"
      case ..<0.5: "30–50 %"
      case ..<0.8: "50–80 %"
      default: "≥ 80 %"
      }
    }
    for k in ["< 10 %", "10–20 %", "20–30 %", "30–50 %", "50–80 %", "≥ 80 %"] {
      let r = rows.filter { bucket($0.zoom) == k }
      print(
        "opening zoom \(k): \(r.count) boards, of them below the cut \(r.filter { $0.cut > 0 && $0.zoom < $0.cut }.count)"
      )
    }
    let ts = times.sorted()
    if !ts.isEmpty {
      print(String(format: "time to the first picture: median %.2f s, max %.2f s", ts[ts.count / 2], ts[ts.count - 1]))
    }
    let cuts = rows.map(\.cut).filter { $0 > 0 }.sorted()
    if !cuts.isEmpty {
      print(
        String(format: "cuts: min %.3f, median %.3f, max %.3f", cuts[0], cuts[cuts.count / 2], cuts[cuts.count - 1]))
    }
  }
}
