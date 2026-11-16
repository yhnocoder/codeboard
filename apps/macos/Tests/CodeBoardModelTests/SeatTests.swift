import Foundation
import Testing

@testable import CodeBoardModel

// Seats at an open board: each view on it (a canvas) has its own selection, which its edits, undo and writing record
// and get back, while what is done to the board reaches every seat

private func cid(_ s: String) -> CardID { CardID(rawValue: s) }

@MainActor private func opened() throws -> (BoardDocument, URL) {
  let file = try scratch().appending(path: "board.json")
  try editSample().encoded().write(to: file)
  return (try BoardDocument(file: { file }), file)
}

/// What sits at a seat, as a canvas does
private final class Holder {}

@MainActor @Suite struct SeatTests {
  @Test func theFirstHolderHasTheDocumentsOwnSeatASecondOneOfItsOwnAndANewHolderTheOwnOnceTheFirstIsGone() throws {
    let (doc, _) = try opened()
    let a = Holder()
    let b = Holder()
    let sa = doc.seat(for: a)
    let sb = doc.seat(for: b)
    #expect(sa !== sb && sa.document === doc && sb.document === doc)
    #expect(doc.seat(for: a) === sa && doc.seat(for: b) === sb, "a holder asking again gets the seat it has")
    sa.select([.card(cid("n1"))])
    #expect(doc.selection == [.card(cid("n1"))], "the first holder's selection is the document's")
    sb.select([.card(cid("n2"))])
    #expect(doc.selection == [.card(cid("n1"))] && sa.selection == [.card(cid("n1"))])
    #expect(sb.selection == [.card(cid("n2"))])
    // the first leaves: the next new holder gets the document's own seat, with the selection it kept
    sa.leave()
    var c: Holder? = Holder()
    let sc = try doc.seat(for: #require(c))
    #expect(sc.selection == [.card(cid("n1"))])
    sc.select([.card(cid("t1"))])
    #expect(doc.selection == [.card(cid("t1"))] && sb.selection == [.card(cid("n2"))])
    // its holder gone without leaving: free again for the next new holder
    c = nil
    let d = Holder()
    let sd = doc.seat(for: d)
    #expect(sd !== sb && sd.selection == [.card(cid("t1"))])
    sd.select([.card(cid("c1"))])
    #expect(doc.selection == [.card(cid("c1"))] && sb.selection == [.card(cid("n2"))])
    withExtendedLifetime((b, d, sc)) {}
  }

  @Test func anEditAtOneSeatRecordsItsSelectionAndTheOthersOnlyLosesWhatWent() throws {
    let (doc, _) = try opened()
    let a = Holder()
    let b = Holder()
    let sa = doc.seat(for: a)
    let sb = doc.seat(for: b)
    sa.select([.card(cid("n1")), .card(cid("c1"))])
    sb.select([.card(cid("c1")), .card(cid("n2"))])
    sb.edit("Delete") { $0.delete([.card(cid("c1"))]) }
    let step = try #require(doc.history.undoSteps.last)
    #expect(step.name == "Delete")
    #expect(step.selectionBefore == [.card(cid("c1")), .card(cid("n2"))] && step.selectionAfter == [.card(cid("n2"))])
    #expect(sb.selection == [.card(cid("n2"))] && sa.selection == [.card(cid("n1"))])
    // undone at the other seat: that seat gets the step's selection, the one that made it keeps its own
    sa.undo()
    #expect(doc.board.card(cid("c1")) != nil)
    #expect(sa.selection == [.card(cid("c1")), .card(cid("n2"))] && sb.selection == [.card(cid("n2"))])
    sb.select([.card(cid("c1"))])
    sb.redo()
    #expect(sb.selection == [.card(cid("n2"))] && sa.selection == [.card(cid("n2"))], "c1 gone from both")
    withExtendedLifetime((a, b)) {}
  }

  @Test func whatTheAppAndAnotherWriterTakeOffTheBoardLeavesEverySeatsSelection() throws {
    let (doc, file) = try opened()
    let a = Holder()
    let b = Holder()
    let sa = doc.seat(for: a)
    let sb = doc.seat(for: b)
    sa.select([.card(cid("n1")), .card(cid("t1"))])
    sb.select([.card(cid("t1")), .card(cid("n2"))])
    doc.sync { $0.delete([.card(cid("t1"))]) }
    #expect(sa.selection == [.card(cid("n1"))] && sb.selection == [.card(cid("n2"))])
    // another writer deletes n2
    var theirs = editSample()
    theirs.delete([.card(cid("n2"))])
    try theirs.encoded().write(to: file)
    doc.diskChanged()
    #expect(doc.board.card(cid("n2")) == nil && doc.board.card(cid("t1")) == nil)
    #expect(sa.selection == [.card(cid("n1"))] && sb.selection.isEmpty)
    withExtendedLifetime((a, b)) {}
  }

  @Test func aSelectionTellsOnlyItsSeatAndAChangeOfTheBoardTellsEvery() throws {
    let (doc, _) = try opened()
    let a = Holder()
    let b = Holder()
    let sa = doc.seat(for: a)
    let sb = doc.seat(for: b)
    var heardA: [BoardDocument.Change] = []
    var heardB: [BoardDocument.Change] = []
    let stopA = sa.observe { heardA.append($0) }
    let stopB = sb.observe { heardB.append($0) }
    defer {
      stopA()
      stopB()
    }
    sb.select([.card(cid("n1"))])
    #expect(heardA.isEmpty && heardB == [.edit])
    sa.select([.card(cid("n2"))])
    #expect(heardA == [.edit] && heardB == [.edit])
    sa.edit("Move") { $0.move([.card(cid("n2"))], dx: 10, dy: 0) }
    #expect(heardA == [.edit, .edit] && heardB == [.edit, .edit])
    doc.sync { $0.move([.card(cid("n1"))], dx: 0, dy: 10) }
    #expect(heardA == [.edit, .edit, .merge] && heardB == [.edit, .edit, .merge])
    withExtendedLifetime((a, b)) {}
  }

  @Test func aNewCardLeftEmptyGivesTheSeatThatMadeItItsSelectionBackAndLeavesTheOthers() throws {
    let (doc, _) = try opened()
    let a = Holder()
    let b = Holder()
    let sa = doc.seat(for: a)
    let sb = doc.seat(for: b)
    sa.select([.card(cid("n1"))])
    sb.select([.card(cid("n2"))])
    sb.addFresh(Board.newCard(.text(.text), id: cid("new"), x: 10, y: 20))
    #expect(sb.selection == [.card(cid("new"))] && sa.selection == [.card(cid("n1"))])
    #expect(doc.freshCard == cid("new") && sa.freshCard == cid("new"))
    // only the seat writing ends its writing; ended: the selection goes back to it
    sa.settleWriting(keep: false, "New Text") { _ in }
    #expect(doc.freshCard == cid("new"))
    sb.settleWriting(keep: false, "New Text") { _ in }
    #expect(doc.board.card(cid("new")) == nil && doc.history.undoSteps.isEmpty)
    #expect(sb.selection == [.card(cid("n2"))] && sa.selection == [.card(cid("n1"))])
    // kept: one step with that seat's selection, the card selected there
    sb.addFresh(Board.newCard(.note, id: cid("new2"), x: 10, y: 20))
    sb.settleWriting(keep: true, "New Note") { $0.write(cid("new2"), text: "Hello", layout: nil) }
    let step = try #require(doc.history.undoSteps.last)
    #expect(step.name == "New Note" && step.selectionBefore == [.card(cid("n2"))])
    #expect(step.selectionAfter == [.card(cid("new2"))])
    #expect(sb.selection == [.card(cid("new2"))] && sa.selection == [.card(cid("n1"))])
    withExtendedLifetime((a, b)) {}
  }

  @Test func aSeatThatStartsWritingWhileAnotherWritesEndsThatWritingKeptAndOnlyTheSeatWritingDraftsOrEndsIt() throws {
    let (doc, _) = try opened()
    let a = Holder()
    let b = Holder()
    let sa = doc.seat(for: a)
    let sb = doc.seat(for: b)
    sa.beginWriting(cid("t1"))
    sa.draft { $0.write(cid("t1"), text: "A typed", layout: nil) }
    // its holder ends it as its own end does (a canvas: its editor goes)
    var taken = 0
    sa.onWritingTaken = {
      taken += 1
      sa.settleWriting(keep: true, "Edit Text") { $0.write(cid("t1"), text: "A typed more", layout: nil) }
    }
    sb.beginWriting(cid("n1"))
    #expect(taken == 1 && doc.undoName == "Edit Text" && doc.board.card(cid("t1"))?.writing == "A typed more")
    // the first seat's late drafts and end touch nothing: the writing is the second's
    sa.draft { $0.write(cid("t1"), text: "late", layout: nil) }
    sa.settleWriting(keep: true, "Edit Text") { $0.write(cid("t1"), text: "later", layout: nil) }
    #expect(doc.board.card(cid("t1"))?.writing == "A typed more" && doc.history.undoSteps.count == 1)
    sb.draft { $0.write(cid("n1"), text: "B typed", layout: nil) }
    #expect(doc.board.card(cid("n1"))?.writing == "B typed")
    sb.settleWriting(keep: true, "Edit Note") { $0.write(cid("n1"), text: "B typed", layout: nil) }
    #expect(doc.undoName == "Edit Note" && doc.history.undoSteps.count == 2)

    // a holder that ends nothing: the writing ends here, kept as its drafts left the board, one step
    sb.beginWriting(cid("n1"))
    sb.draft { $0.write(cid("n1"), text: "B again", layout: nil) }
    sa.beginWriting(cid("t1"))
    #expect(doc.board.card(cid("n1"))?.writing == "B again" && doc.history.undoSteps.count == 3)
    sa.draft { $0.write(cid("t1"), text: "A again", layout: nil) }
    #expect(doc.board.card(cid("t1"))?.writing == "A again")
    withExtendedLifetime((a, b)) {}
  }
}
