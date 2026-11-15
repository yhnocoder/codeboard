import AppKit
import CodeBoardCanvas
import CodeBoardModel

/// `--drag`: drags one card, twenty cards and the Section with the most in it across the board, at the zoom that fits it
/// and at 100 %, in a window that is never put on screen (nothing takes the focus or reaches the screen). Each step is
/// one mouse-dragged event handled and committed to Core Animation, timed on the main thread; a step under 8.3 ms
/// keeps 120 Hz, under 16.7 ms 60 Hz. Also: the release (the step saved), the swap that follows once the scene is made
/// again, and the work the gesture rule forbids while dragging. Prints one JSON object per board.
@MainActor struct DragBench {
  let canvas: CanvasView
  let window: NSWindow

  func run(_ b: VaultBoard, in vault: Vault, scratch: URL) async throws -> String {
    // a copy of the board, so the original is never written
    let package = scratch.appending(path: "drag-\(UUID().uuidString).board")
    try FileManager.default.copyItem(at: vault.url(of: b.path), to: package)
    defer { try? FileManager.default.removeItem(at: package) }
    let copyVault = Vault(root: scratch)
    let file = package.appending(path: Vault.boardFileName)
    let doc = try BoardDocument { file }
    let at = VaultBoard(id: b.id, title: b.title, path: package.lastPathComponent)
    try await canvas.show(doc, at: at, in: copyVault, theme: .warmInk)
    let fit = canvas.zoom
    let board = doc.board
    var out: [String: Any] = ["board": b.id.rawValue, "cards": board.cards.count, "sections": board.sections.count]
    for (name, zoom) in [("fit", fit), ("100", 1.0)] {
      var r: [String: Any] = ["zoom": Double(zoom)]
      let free = canvas.cardRects.filter { !board.isLocked(.card($0.id)) }
      guard !free.isEmpty else { break }
      let middle = CGPoint(x: canvas.boardBounds.midX, y: canvas.boardBounds.midY)
      func near(_ r: CGRect) -> CGFloat { hypot(r.midX - middle.x, r.midY - middle.y) }
      let byDistance = free.sorted { near($0.rect) < near($1.rect) }
      // one card, then twenty, each grabbed by its top-left corner (the card drawn on top there is the one grabbed)
      let one = byDistance[0]
      r["one"] = await drag(doc, [.card(one.id)], from: grab(one.rect), zoom: zoom, centre: middle)
      let twenty = Array(byDistance.prefix(20))
      r["twenty"] = await drag(
        doc, Set(twenty.map { .card($0.id) }), from: grab(twenty[0].rect), zoom: zoom, centre: middle)
      r["twentyCount"] = twenty.count
      let carried = board.sections.map { ($0.id, board.carried([.section($0.id)]).cards.count) }
      if let (id, n) = carried.max(by: { $0.1 < $1.1 }), let t = canvas.sectionTitle(id) {
        r["section"] = await drag(
          doc, [.section(id)], from: CGPoint(x: t.midX, y: t.midY), zoom: zoom, centre: middle)
        r["sectionCards"] = n
      }
      out[name] = r
    }
    let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
    return String(decoding: data, as: UTF8.self)
  }

  private func grab(_ r: CGRect) -> CGPoint {
    CGPoint(x: r.minX + min(12, r.width / 4), y: r.minY + min(12, r.height / 4))
  }

  /// 120 steps of 6 view points each way, after a press on `from` with `items` selected; then the release and undo
  private func drag(
    _ doc: BoardDocument, _ items: Set<Item>, from: CGPoint, zoom: CGFloat, centre: CGPoint
  ) async -> [String: Any] {
    canvas.place(zoom: zoom, centre: from)
    doc.select(items)
    await canvas.refreshing?.value
    let start = canvas.viewPoint(from)
    let rules = canvas.ruleBreaks
    var t: TimeInterval = 1
    func event(_ type: NSEvent.EventType, _ v: CGPoint) -> NSEvent {
      t += 1.0 / 120
      return NSEvent.mouseEvent(
        with: type, location: canvas.convert(v, to: nil), modifierFlags: [], timestamp: t,
        windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    }
    canvas.mouseDown(with: event(.leftMouseDown, start))
    var steps: [Double] = []
    for i in 1...120 {
      let v = CGPoint(x: start.x + CGFloat(i) * 6, y: start.y + CGFloat(i) * 3)
      let t0 = CACurrentMediaTime()
      canvas.mouseDragged(with: event(.leftMouseDragged, v))
      CATransaction.flush()
      steps.append((CACurrentMediaTime() - t0) * 1000)
    }
    let t0 = CACurrentMediaTime()
    canvas.mouseUp(with: event(.leftMouseUp, CGPoint(x: start.x + 720, y: start.y + 360)))
    CATransaction.flush()
    let release = (CACurrentMediaTime() - t0) * 1000
    await canvas.refreshing?.value
    let swap = canvas.lastInstall
    let broke = canvas.ruleBreaks
    let moved = doc.undoName == "Move"
    doc.undo()
    await canvas.refreshing?.value
    let sorted = steps.sorted()
    func ms(_ x: Double) -> Double { (x * 100).rounded() / 100 }
    return [
      "moved": moved, "stepP50": ms(sorted[sorted.count / 2]), "stepP95": ms(sorted[sorted.count * 95 / 100]),
      "stepMax": ms(sorted.last!), "over8_3ms": steps.filter { $0 > 1000 / 120 }.count,
      "over16_7ms": steps.filter { $0 > 1000 / 60 }.count, "releaseMs": ms(release), "swapMs": ms(swap.seconds * 1000),
      "swapDrawn": swap.drawn,
      "ruleBreaks": (broke.redraws - rules.redraws) + (broke.decodes - rules.decodes) + (broke.swaps - rules.swaps)
        + (broke.noteRequests - rules.noteRequests) + (broke.noteSwaps - rules.noteSwaps),
    ]
  }
}
