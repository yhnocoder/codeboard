import CoreGraphics
import Testing

@testable import CodeUI

private let m = CodeLineMetrics(row: 20, fold: 24, padLeft: 17, numberGap: 22, padRight: 18, charWidth: 6.6)

private func kinds(_ l: CodeLines) -> [CodeLines.Kind] { l.rows.map(\.kind) }

@Suite struct CodeLinesTests {
  @Test func foldsTakeOneRowAndBlankLinesGoWhenAsked() {
    let l = CodeLines(
      lines: ["a", " ", "b", "c", "d"], firstNumber: 10, folds: [12...13, 13...20], hideBlankLines: true, top: 6,
      metrics: m)
    // the second fold starts where the first ended, and stops at the last line
    #expect(
      kinds(l) == [
        .line(number: 10, wrapped: false, text: "a", runs: []), .fold(12...13), .fold(14...14),
      ])
    #expect(l.rows.map(\.y) == [6, 26, 50] && l.bottom == 74)
  }

  @Test func aLongLineWrapsAndItsRunsAreCutWithIt() {
    // a tab is four spaces; the run covers "xyz" (columns 1–4 of the line as given)
    let l = CodeLines(
      lines: ["\txyz"], runs: [[CodeRun(columns: 1..<4, style: 3)]], wrapColumns: 5, metrics: m)
    #expect(
      kinds(l) == [
        .line(number: 1, wrapped: false, text: "    x", runs: [CodeRun(columns: 4..<5, style: 3)]),
        .line(number: 1, wrapped: true, text: "yz", runs: [CodeRun(columns: 0..<2, style: 3)]),
      ])
  }

  @Test func insertedRoomGoesAfterItsLineInTheOrderGiven() {
    var l = CodeLines(lines: ["a", "b", "", "c"], folds: [2...2], hideBlankLines: true, metrics: m)
    // after line 3, which is left out: after the fold of line 2; then after the last line; then before everything
    l.insert([
      .init(afterLine: 3, height: 10), .init(afterLine: 2, height: 5), .init(afterLine: 9, height: 1),
      .init(afterLine: 0, height: 2),
    ])
    #expect(
      kinds(l) == [
        .inserted(3), .line(number: 1, wrapped: false, text: "a", runs: []), .fold(2...2), .inserted(0), .inserted(1),
        .line(number: 4, wrapped: false, text: "c", runs: []), .inserted(2),
      ])
    #expect(l.rows.map(\.y) == [0, 2, 22, 46, 56, 61, 81] && l.bottom == 82)
  }

  @Test func theGutterTheColumnsAndTheIndentTakenOff() {
    #expect(CodeLines.gutter(lastNumber: 120, metrics: m) == 17 + 3 * 6.6 + 22)
    #expect(CodeLines.columns(width: 100, gutter: 50, metrics: m) == 4)
    #expect(CodeLines.columns(width: 10, gutter: 50, metrics: m) == 1)
    let d = CodeLines.dedent(["    a", "", "      b"], metrics: m)
    #expect(d.columns == 4 && d.shift == 16 - 4 * 6.6)
    #expect(CodeLines.dedent([" a", "    b"], metrics: m) == (0, 0))
    #expect(CodeLines.indent("\t  x", tabWidth: 4) == 6)
  }

  @Test func aRunOfLinesSpansItsShownRowsAndTheRoomItReaches() {
    var l = CodeLines(
      lines: ["abcdef", "", "x", "y"], folds: [3...3], hideBlankLines: true, wrapColumns: 4, metrics: m)
    l.insert([.init(afterLine: 4, height: 30)])
    // line 1 wraps into two rows; 2 is left out; 3 is folded; 4 is shown, the room after it
    #expect(l.span(1...2) == CGFloat(0)...40)
    #expect(l.span(2...3) == nil)
    #expect(l.span(1...4) == CGFloat(0)...84)
    #expect(l.span(4...4, through: 0) == CGFloat(64)...114)
    #expect(l.lineRows.map(\.line) == [1, 4])
  }

  /// A range of lines' frame: its rows from the first to the last, a wrapped line's all of them, the folds among them;
  /// lines all folded away are the fold's row, marked folded; lines left out have none
  @Test func aRangeOfLinesIsFramedByItsRowsAndAFoldStandsInForWhatItHolds() {
    let l = CodeLines(
      lines: ["a = 1", String(repeating: "b", count: 15), "", "c", "d"], folds: [4...5], hideBlankLines: true,
      wrapColumns: 10, top: 6, metrics: m)
    let wrapped = l.frame(of: 2...2, width: 300)
    #expect(wrapped?.rect == CGRect(x: 0, y: 26, width: 300, height: 40) && wrapped?.folded == false)
    #expect(wrapped?.first == CGRect(x: 0, y: 26, width: 300, height: 20))
    #expect(l.frame(of: 1...2, width: 300)?.rect == CGRect(x: 0, y: 6, width: 300, height: 60))
    #expect(l.frame(of: 3...3, width: 300) == nil)
    let fold = l.frame(of: 4...4, width: 300)
    #expect(
      fold?.folded == true && fold?.rect == CGRect(x: 0, y: 66, width: 300, height: 24) && fold?.first == fold?.rect)
    let some = l.frame(of: 2...5, width: 300)
    #expect(some?.folded == false && some?.rect == CGRect(x: 0, y: 26, width: 300, height: 64))
  }
}
