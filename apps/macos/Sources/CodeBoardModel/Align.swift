/// How cards line up or spread out (core layout.ts AlignOp)
public enum AlignOp: CaseIterable, Sendable {
  case left, hcenter, right, top, bottom, hdist, vdist
}

extension Board {
  /// commands/sections.ts alignCards over core layout.ts align: the cards, at their frames as drawn, line up on an edge
  /// or the middle of what they cover together, or spread out over it with equal gaps; the locked ones count but stay
  public mutating func align(_ rs: [(id: CardID, rect: Rect)], _ op: AlignOp) {
    guard rs.count >= 2 else { return }
    let x0 = rs.map(\.rect.x).min()!
    let y0 = rs.map(\.rect.y).min()!
    let x1 = rs.map { $0.rect.x + $0.rect.width }.max()!
    let y1 = rs.map { $0.rect.y + $0.rect.height }.max()!
    var to: [CardID: (x: Double?, y: Double?)] = [:]
    // JS's sort is stable: equal ones keep their order
    func spread(_ at: (Rect) -> Double, _ size: (Rect) -> Double, from: Double, over: Double) -> [(CardID, Double)] {
      let s = rs.enumerated().sorted { (at($0.1.rect), $0.0) < (at($1.1.rect), $1.0) }.map(\.1)
      let gap = (over - s.reduce(0) { $0 + size($1.rect) }) / Double(s.count - 1)
      var p = from
      return s.map { r in
        defer { p += size(r.rect) + gap }
        return (r.id, p)
      }
    }
    switch op {
    case .left: for r in rs { to[r.id] = (x0, nil) }
    case .right: for r in rs { to[r.id] = (x1 - r.rect.width, nil) }
    case .hcenter: for r in rs { to[r.id] = (x0 + (x1 - x0) / 2 - r.rect.width / 2, nil) }
    case .top: for r in rs { to[r.id] = (nil, y0) }
    case .bottom: for r in rs { to[r.id] = (nil, y1 - r.rect.height) }
    case .hdist: for (id, x) in spread(\.x, \.width, from: x0, over: x1 - x0) { to[id] = (x, nil) }
    case .vdist: for (id, y) in spread(\.y, \.height, from: y0, over: y1 - y0) { to[id] = (nil, y) }
    }
    for i in cards.indices {
      guard let p = to[cards[i].id], !isLocked(.card(cards[i].id)) else { continue }
      if let x = p.x { cards[i].x = x }
      if let y = p.y { cards[i].y = y }
    }
  }
}
