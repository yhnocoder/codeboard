import Foundation
import Testing

@testable import CodeBoardModel

// Arrows and Sections as commands (core commands/links.ts, sections.ts, cards.ts newSection)

private func cid(_ s: String) -> CardID { CardID(rawValue: s) }
private func gid(_ s: String) -> SectionID { SectionID(rawValue: s) }
private func aid(_ s: String) -> ArrowID { ArrowID(rawValue: s) }

@Test func anArrowGoesBetweenTwoPlacesNeverFromAPlaceToItself() {
  var b = editSample()
  let ok1 = b.addArrow(aid("x1"), from: Endpoint(card: cid("n1")), to: Endpoint(card: cid("n2")), side: .right)
  #expect(ok1)
  #expect(b.arrow(aid("x1"))?.from.side == .right && b.arrow(aid("x1"))?.to.side == nil, "the side it left from")
  #expect(
    b.arrow(aid("x1"))?.width == 2 && b.arrow(aid("x1"))?.endHead == true && b.arrow(aid("x1"))?.startHead == false)
  let ok2 = b.addArrow(aid("x2"), from: Endpoint(card: cid("n1")), to: Endpoint(card: cid("n1")))
  #expect(!ok2, "a card to itself")
  let line = { (n: Int) in Endpoint(card: cid("c1"), segment: SegmentID(rawValue: "s1"), line: n) }
  let ok3 = b.addArrow(aid("x3"), from: line(1), to: line(3))
  #expect(ok3, "two lines of one card")
  let ok4 = b.addArrow(aid("x4"), from: line(1), to: line(1))
  #expect(!ok4)
  let ok5 = b.addArrow(aid("x5"), from: Endpoint(card: cid("n1")), to: Endpoint(card: cid("gone")))
  #expect(!ok5)
  #expect(b.brokenReference == nil)
}

@Test func anEndMovesToAnotherPlaceAndChoosesItsSideAgain() {
  var b = editSample()
  b.setArrowSide(aid("a1"), .to, .left)
  let ok6 = b.retarget(aid("a1"), .to, to: Endpoint(card: cid("n2"), side: .top, lost: true))
  #expect(ok6)
  #expect(b.arrow(aid("a1"))?.to == Endpoint(card: cid("n2")))
  let ok7 = b.retarget(aid("a1"), .from, to: Endpoint(card: cid("n2")))
  #expect(!ok7, "onto its other end")
  let ok8 = b.retarget(aid("a1"), .from, to: Endpoint(card: cid("gone")))
  #expect(!ok8)
  #expect(b.arrow(aid("a1"))?.from.card == cid("c1"))
}

@Test func anArrowsLabelLookAndSides() {
  var b = editSample()
  let a = aid("a1")
  b.setArrowLabel(a, "  calls  ")
  #expect(b.arrow(a)?.label == "calls")
  b.setLabelPosition(a, 1.4)
  #expect(b.arrow(a)?.labelPosition == 1)
  b.setLabelPosition(a, nil)
  b.setArrowLabel(a, " \n ")
  #expect(b.arrow(a)?.label == nil && b.arrow(a)?.labelPosition == nil, "blank clears it")
  b.setArrowsDashed([a], true)
  b.setArrowsWidth([a], 7)
  b.setArrowsHead([a], .from, true)
  b.setArrowsHead([a], .to, false)
  b.setArrowsColor([a], "orange")
  let s = b.arrow(a)!
  #expect(s.dashed && s.width == 3 && s.startHead && !s.endHead && s.color == "orange")
  b.setArrowSide(a, .from, .bottom)
  b.setArrowSide(a, .to, .left)
  #expect(b.arrow(a)?.from.side == .bottom && b.arrow(a)?.to.side == .left)
  b.setArrowSide(a, .from, nil)
  #expect(b.arrow(a)?.from.side == nil)
  #expect(b.arrow(aid("a2"))?.dashed == false, "only the ones given")
}

@Test func deletingAnArrowLeavesItsCards() {
  var b = editSample()
  b.delete([.arrow(aid("a1"))])
  #expect(b.arrow(aid("a1")) == nil && b.card(cid("c1")) != nil && b.card(cid("n1")) != nil)
  #expect(b.arrow(aid("a2")) != nil)
  #expect(!b.isLocked(.arrow(aid("a2"))))
}

@Test func aNewSectionTakesItsCardsAndSectionsAndItsParent() {
  var b = editSample()
  // around a selection: the Section its cards were all in
  b.addSection(gid("g3"), x: 40, y: 90, width: 220, height: 160, drawn: false, cards: [cid("n1")], sections: [])
  #expect(b.section(gid("g3"))?.parent == gid("g1") && b.section(gid("g3"))?.title == "Untitled Section")
  #expect(b.card(cid("n1"))?.section == gid("g3"))
  // drawn: the parent given; a Section inside it becomes its child, never one around it
  b.addSection(
    gid("g4"), x: 0, y: 0, width: 2000, height: 2000, drawn: true, parent: nil, cards: [], sections: [gid("g1")])
  #expect(b.section(gid("g4"))?.parent == nil && b.section(gid("g1"))?.parent == gid("g4"))
  b.addSection(
    gid("g5"), x: 10, y: 10, width: 50, height: 50, drawn: true, parent: gid("g1"), cards: [], sections: [gid("g4")])
  #expect(b.section(gid("g4"))?.parent == nil, "not inside a Section inside it")
  #expect(b.brokenReference == nil)
}

@Test func aSectionsTitleColourAndOneLevelOut() {
  var b = editSample()
  b.renameSection(gid("g2"), "  Warps ")
  #expect(b.section(gid("g2"))?.title == "Warps")
  b.renameSection(gid("g2"), "   ")
  #expect(b.section(gid("g2"))?.title == "Untitled Section")
  b.setSectionColor([gid("g1"), gid("g2")], "sand")
  #expect(b.sections.allSatisfy { $0.color == "sand" })
  b.setSectionColor([gid("g2")], nil)
  #expect(b.section(gid("g2"))?.color == nil && b.section(gid("g1"))?.color == "sand")
  b.moveOutOfParent(gid("g2"))
  #expect(b.section(gid("g2"))?.parent == nil)
  b.moveOutOfParent(gid("g2"))
  #expect(b.section(gid("g2"))?.parent == nil)
}
