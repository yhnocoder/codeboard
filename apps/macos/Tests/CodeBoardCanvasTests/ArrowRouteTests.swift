import CoreGraphics
import Testing

@testable import CodeBoardCanvas

// Ported from packages/core/test/route.test.ts and labelpos.test.ts (the curve route; the elbow route and the side
// slide are not part of this canvas).

typealias R = ArrowRoute
private let card = CGRect(x: 0, y: 0, width: 300, height: 200)
private func at(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat = 300, _ h: CGFloat = 160) -> CGRect {
  CGRect(x: x, y: y, width: w, height: h)
}
private func sides(_ m: R.Mode) -> [R.Side] { [R.sides(m).0, R.sides(m).1] }

@Suite struct ChooseModeTests {
  @Test func separatedFacesSidesForLineAndCardEnds() {
    #expect(sides(R.chooseMode(card, at(500, 40), cards: false, prev: nil, buffer: 16)) == [.right, .left])
    #expect(sides(R.chooseMode(card, at(-500, 40), cards: true, prev: nil, buffer: 16)) == [.left, .right])
  }

  @Test func stackedWithALineEndTakesTheSameSideByTheTargetsLean() {
    #expect(sides(R.chooseMode(card, at(120, 400), cards: false, prev: nil, buffer: 16)) == [.right, .right])
    #expect(sides(R.chooseMode(card, at(-120, 400), cards: false, prev: nil, buffer: 16)) == [.left, .left])
  }

  @Test func stackedCardToCardGoesBottomToTop() {
    #expect(sides(R.chooseMode(card, at(120, 400), cards: true, prev: nil, buffer: 16)) == [.bottom, .top])
    #expect(sides(R.chooseMode(card, at(120, -400), cards: true, prev: nil, buffer: 16)) == [.top, .bottom])
  }

  @Test func hysteresisNeedsTheBufferToSeparateAndAnOverlapToStop() {
    #expect(R.chooseMode(card, at(308, 40), cards: false, prev: nil, buffer: 16) == .stackR)
    #expect(R.chooseMode(card, at(308, 40), cards: false, prev: .sepR, buffer: 16) == .sepR)
    #expect(R.chooseMode(card, at(290, 40), cards: false, prev: .sepR, buffer: 16) == .stackR)
    #expect(R.chooseMode(card, at(308, 40), cards: false, prev: .stackR, buffer: 16) == .stackR)
    #expect(R.chooseMode(card, at(320, 40), cards: false, prev: .stackR, buffer: 16) == .sepR)
  }

  @Test func theCShapeLeanAlsoWaitsForTheBuffer() {
    #expect(R.chooseMode(card, at(-10, 400), cards: false, prev: .stackR, buffer: 16) == .stackR)
    #expect(R.chooseMode(card, at(-30, 400), cards: false, prev: .stackR, buffer: 16) == .stackL)
  }

  @Test func sideBySideWithAGapBelowTheBufferStillFaces() {
    let a = CGRect(x: 0, y: 0, width: 300, height: 200)
    #expect(sides(R.chooseMode(a, at(308, 20, 260), cards: true, prev: nil, buffer: 16)) == [.right, .left])
    #expect(sides(R.chooseMode(a, at(-268, 20, 260), cards: true, prev: nil, buffer: 16)) == [.left, .right])
    #expect(R.chooseMode(a, at(308, 190, 260), cards: true, prev: .down, buffer: 16) == .down)
    #expect(R.chooseMode(a, at(308, 150, 260), cards: true, prev: .down, buffer: 16) == .sepR)
  }
}

@Suite struct ConnectTests {
  @Test func cardEndsSitOnTheHeadingRowOrTheMiddleOfTheEdge() {
    #expect(R.anchor(card, .left, rowY: 17) == Anchor(x: 0, y: 17, nx: -1, ny: 0))
    #expect(R.anchor(card, .right, rowY: 17) == Anchor(x: 300, y: 17, nx: 1, ny: 0))
    #expect(R.anchor(card, .bottom, rowY: 17) == Anchor(x: 150, y: 200, nx: 0, ny: 1))
  }

  @Test func tiltIsAtMostFortyFiveDegreesTowardTheOtherEndOnlyWhenShortOfRoom() {
    let p = Anchor(x: 0, y: 0, nx: 1, ny: 0)
    #expect(abs(R.tiltAngle(p, CGPoint(x: 18, y: 200)) - .pi / 4) < 1e-6)
    #expect(abs(R.tiltAngle(p, CGPoint(x: 18, y: -200)) + .pi / 4) < 1e-6)
    #expect(R.tiltAngle(p, CGPoint(x: 600, y: 200)) == 0)
    #expect(R.tiltAngle(p, CGPoint(x: -50, y: 200)) == 0)
  }

  @Test func theArrowheadFollowsTheTiltedEnd() {
    let sh = R.connect(Anchor(x: 150, y: 70, nx: -1, ny: 0), Anchor(x: 102, y: 104, nx: 1, ny: 0))
    let ang = atan2(sh.inDir.dy, -sh.inDir.dx)
    #expect(ang > 0.2 && ang <= .pi / 4 + 1e-6)
  }

  @Test(
    arguments: [
      (CGRect(x: 420, y: 60, width: 900, height: 200), 320.0), (CGRect(x: 420, y: 60, width: 900, height: 140), 320),
      (CGRect(x: 420, y: 60, width: 300, height: 230), 310),
    ] as [(CGRect, CGFloat)])
  func perpendicularEndsStayBetweenTheirEnds(b: CGRect, py: CGFloat) {
    let a = CGRect(x: 80, y: 300, width: 300, height: 200)
    let p = R.anchor(a, .right, rowY: py)
    let q = R.anchor(b, .bottom, rowY: 0)
    let box = R.bezBox(R.connect(p, q, a: a, b: b).pts)
    #expect(box.maxY <= p.y + 0.5)
    #expect(box.maxX <= q.x + 0.5)
  }
}

/// Close cards: the arrow never runs through either card (#65)
@Suite struct CloseCardsTests {
  let a = CGRect(x: 0, y: 0, width: 300, height: 200)

  func sample(_ path: [PathOp]) -> [CGPoint] {
    var out: [CGPoint] = []
    var cur = CGPoint.zero
    for op in path {
      let ps: [CGPoint]
      switch op {
      case .move(let p):
        cur = p
        out.append(p)
        continue
      case .line(let p): ps = [cur, p]
      case .quad(let c, let p): ps = [cur, c, p]
      case .curve(let c1, let c2, let p): ps = [cur, c1, c2, p]
      }
      for s in 1...24 {
        let t = CGFloat(s) / 24
        var q = ps
        while q.count > 1 {
          q = (1..<q.count).map {
            CGPoint(x: q[$0 - 1].x + (q[$0].x - q[$0 - 1].x) * t, y: q[$0 - 1].y + (q[$0].y - q[$0 - 1].y) * t)
          }
        }
        out.append(q[0])
      }
      cur = ps[ps.count - 1]
    }
    return out
  }

  func inside(_ p: CGPoint, _ b: CGRect, _ e: CGFloat) -> Bool {
    p.x > b.minX + e && p.x < b.maxX - e && p.y > b.minY + e && p.y < b.maxY - e
  }

  func anchor(_ b: CGRect, _ s: R.Side) -> Anchor { R.anchor(b, s, rowY: b.minY + 17) }

  /// A pinned side facing and touching the other card: every route runs through it, so it does not count
  func blocked(_ b: CGRect, _ s: (R.Side, R.Side)) -> Bool {
    let p = anchor(a, s.0)
    let q = anchor(b, s.1)
    return inside(CGPoint(x: p.x + p.nx, y: p.y + p.ny), b, 0) || inside(CGPoint(x: q.x + q.nx, y: q.y + q.ny), a, 0)
  }

  func bad(_ b: CGRect, _ s: (R.Side, R.Side)) -> String? {
    let p = anchor(a, s.0)
    let q = anchor(b, s.1)
    let sh = R.connect(p, q, a: a, b: b)
    let pts = sample(sh.path)
    if let hit = pts.first(where: { inside($0, a, 4) || inside($0, b, 4) }) { return "enters a card at \(hit)" }
    if let last = pts.last, hypot(last.x - q.x, last.y - q.y) > 0.2 { return "ends at \(last), not on the target" }
    if sh.inDir.dx * -q.nx + sh.inDir.dy * -q.ny < 0.6 { return "head does not point into the target: \(sh.inDir)" }
    return nil
  }

  /// b placed all around a: gaps from overlapping to under the stub, to a normal distance
  var placements: [CGRect] {
    let gaps: [CGFloat] = [-120, -40, -8, 0, 4, 10, 16, 24, 31, 40, 80]
    var out: [CGRect] = []
    for g in gaps {
      for dy: CGFloat in [-260, -150, -60, -17, 0, 30, 90, 150, 260] {
        out += [
          CGRect(x: 300 + g, y: dy, width: 260, height: 160), CGRect(x: -260 - g, y: dy, width: 260, height: 160),
        ]
      }
      for dx: CGFloat in [-300, -150, -40, 0, 60, 200, 330] {
        out += [
          CGRect(x: dx, y: 200 + g, width: 260, height: 160), CGRect(x: dx, y: -160 - g, width: 260, height: 160),
        ]
      }
    }
    return out.filter { $0.minX >= a.maxX || $0.maxX <= a.minX || $0.minY >= a.maxY || $0.maxY <= a.minY }
  }

  @Test func automaticSidesEveryPlacement() {
    let fails = placements.compactMap { b in
      bad(b, R.sides(R.chooseMode(a, b, cards: true, prev: nil, buffer: 16))).map { "\(b) \($0)" }
    }
    #expect(fails == [])
  }

  @Test func pinnedSidesAnyPortPairEveryPlacement() {
    var fails: [String] = []
    for b in placements {
      for s0 in R.Side.allCases {
        for s1 in R.Side.allCases where !blocked(b, (s0, s1)) {
          if let why = bad(b, (s0, s1)) { fails.append("\(b) \(s0)→\(s1) \(why)") }
        }
      }
    }
    #expect(fails.isEmpty, "\(fails.prefix(5))")
  }
}

@Suite struct LabelPlacementTests {
  // a straight line from (0, 0) to (400, 0), a card at each end
  let line = [CGPoint(x: 0, y: 0), CGPoint(x: 100, y: 0), CGPoint(x: 300, y: 0), CGPoint(x: 400, y: 0)]
  let cards = [CGRect(x: -200, y: -50, width: 200, height: 100), CGRect(x: 400, y: -50, width: 200, height: 100)]
  let box = CGSize(width: 80, height: 20)

  @Test func bezAtWalksTheCurve() {
    #expect(R.bezAt(line, 0) == CGPoint(x: 0, y: 0))
    #expect(R.bezAt(line, 1) == CGPoint(x: 400, y: 0))
    #expect(abs(R.bezAt(line, 0.5).x - 200) < 1e-9)
  }

  @Test func boxClearKeepsAGapToTheCards() {
    #expect(R.boxClear(CGPoint(x: 200, y: 0), box, cards))
    #expect(!R.boxClear(CGPoint(x: 42, y: 0), box, cards))
    #expect(R.boxClear(CGPoint(x: 50, y: 0), box, cards))
  }

  @Test func placeTKeepsAClearRatioAndPullsInWhenACardMovedClose() {
    #expect(R.placeT(line, 0.3, box, cards) == 0.3)
    let near = [cards[0], CGRect(x: 300, y: -50, width: 200, height: 100)]
    let t = R.placeT(line, 0.9, box, near)
    #expect(t < 0.9 && t >= 0.5)
    #expect(R.boxClear(R.bezAt(line, t), box, near))
  }
}
