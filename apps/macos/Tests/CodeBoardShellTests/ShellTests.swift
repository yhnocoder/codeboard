import CodeBoardCanvas
import CoreGraphics
import Foundation
import Testing

@testable import CodeBoardModel
@testable import CodeBoardShell

private func id(_ s: String) -> BoardID { BoardID(rawValue: s) }

/// A vault "v" with boards a, b, c at the top and d in folder f
private func tree(_ boards: [(String, String)] = [("a", "A.board"), ("b", "B.board"), ("c", "C.board")]) -> VaultFolder
{
  VaultFolder(
    name: "v", path: "",
    folders: [
      VaultFolder(name: "f", path: "f", folders: [], boards: [VaultBoard(id: id("d"), title: "D", path: "f/D.board")])
    ],
    boards: boards.map { VaultBoard(id: id($0.0), title: String($0.1.dropLast(6)), path: $0.1) })
}

@MainActor private func shell() -> Shell {
  let s = Shell()
  s.open(Vault(root: URL(filePath: "/v")), restoring: nil)
  s.apply(.success(tree()))
  return s
}

@MainActor @Suite struct ShellTests {
  @Test func firstBoardOpensATab() {
    let s = shell()
    s.show(id("a"))
    #expect(s.tabs.map(\.board) == [id("a")])
    #expect(s.selected == s.tabs[0].id)
  }

  @Test func showingInTheCurrentTabGrowsItsHistory() {
    let s = shell()
    s.show(id("a"))
    s.show(id("b"))
    s.show(id("b"))
    #expect(s.tabs.count == 1)
    #expect(s.current?.board == id("b"))
    #expect(s.current?.back == [id("a")])
    s.goBack()
    #expect(s.current?.board == id("a"))
    #expect(s.canGoForward && !s.canGoBack)
    s.goForward()
    #expect(s.current?.board == id("b"))
    s.goBack()
    s.show(id("c"))
    #expect(!s.canGoForward)
    #expect(s.current?.back == [id("a")])
  }

  @Test func aNewTabOpensAfterTheCurrentOneAndIsSelected() {
    let s = shell()
    s.show(id("a"))
    s.show(id("b"), newTab: true)
    s.select(s.tabs[0].id)
    s.show(id("c"), newTab: true)
    #expect(s.tabs.map(\.board) == [id("a"), id("c"), id("b")])
    #expect(s.current?.board == id("c"))
    #expect(s.current?.back == [])
  }

  @Test func closingSelectsTheRightNeighbourThenTheLeft() {
    let s = shell()
    for b in ["a", "b", "c"] { s.show(id(b), newTab: true) }
    s.select(s.tabs[1].id)
    s.close(s.tabs[1].id)
    #expect(s.current?.board == id("c"))
    s.close(s.tabs[1].id)
    #expect(s.current?.board == id("a"))
    s.close(s.tabs[0].id)
    #expect(s.selected == nil && s.tabs.isEmpty)
  }

  @Test func closingAnotherTabKeepsTheSelection() {
    let s = shell()
    for b in ["a", "b"] { s.show(id(b), newTab: true) }
    s.close(s.tabs[0].id)
    #expect(s.current?.board == id("b"))
  }

  @Test func reorderAndSwitchWrapAround() {
    let s = shell()
    for b in ["a", "b", "c"] { s.show(id(b), newTab: true) }
    s.move(s.tabs[2].id, to: 0)
    #expect(s.tabs.map(\.board) == [id("c"), id("a"), id("b")])
    #expect(s.current?.board == id("c"))
    s.selectTab(by: -1)
    #expect(s.current?.board == id("b"))
    s.selectTab(by: 1)
    #expect(s.current?.board == id("c"))
  }

  @Test func aBoardMovedOnDiskKeepsItsTab() {
    let s = shell()
    s.show(id("a"))
    s.apply(.success(tree([("a", "Renamed.board"), ("b", "B.board")])))
    #expect(s.current?.board == id("a"))
    #expect(s.board(id("a"))?.path == "Renamed.board")
    #expect(s.board(id("a"))?.title == "Renamed")
  }

  @Test func aBoardGoneFromDiskClosesItsTabAndLeavesEveryHistory() {
    let s = shell()
    s.show(id("a"))
    s.show(id("b"))
    s.show(id("c"), newTab: true)
    s.apply(.success(tree([("b", "B.board")])))
    #expect(s.tabs.map(\.board) == [id("b")])
    #expect(s.current?.board == id("b"))
    #expect(!s.canGoBack)
  }

  @Test func anUnreadableTreeKeepsTheTabs() {
    let s = shell()
    s.show(id("a"))
    s.apply(.failure(VaultError.malformed(URL(filePath: "/v/A.board/board.json"), "no id")))
    #expect(s.tabs.count == 1)
    #expect(s.treeError != nil)
    s.apply(.success(tree()))
    #expect(s.treeError == nil)
  }

  @Test func theStateRoundTripsThroughRelaunch() throws {
    let s = shell()
    s.show(id("a"))
    s.show(id("b"))
    s.show(id("d"), newTab: true)
    s.select(s.tabs[0].id)
    s.expanded = ["f"]
    s.sidebarShown = false
    let saved = try JSONDecoder().decode(ShellState.self, from: JSONEncoder().encode(try #require(s.state)))

    let t = Shell()
    t.open(Vault(root: URL(filePath: "/v")), restoring: saved)
    t.apply(.success(tree()))
    #expect(t.tabs == s.tabs)
    #expect(t.selected == s.selected)
    #expect(t.expanded == ["f"])
    #expect(!t.sidebarShown)
    #expect(t.canGoBack)
  }

  @Test func anotherVaultStartsWithoutTabs() throws {
    let s = shell()
    s.show(id("a"))
    let saved = try #require(s.state)
    let t = Shell()
    t.open(Vault(root: URL(filePath: "/other")), restoring: saved)
    #expect(t.tabs.isEmpty && t.selected == nil)
  }

  @Test func importSummaryCountsBoardsCardsFailuresAndLeftOut() {
    let report = ImportReport(
      imported: [
        .init(source: "a.json", destination: "A.board", skipped: [.init(kind: .webCard, ids: ["x", "y"])]),
        .init(source: "g/b.json", destination: "g/B.board", skipped: [.init(kind: .sidenote, ids: ["s"])]),
        .init(source: "cards/c.json", destination: ".codeboard/shared/c.json", skipped: []),
      ],
      failed: [.malformed(URL(filePath: "/old/z.json"), "bad")])
    let summary = ImportSummary(report)
    #expect(summary.title == "Imported 2 boards and 1 shared card")
    #expect(summary.subtitle == "1 file could not be imported. 3 items left out, which this version does not show yet.")
    #expect(summary.details == ["/old/z.json: bad", "sidenote: 1", "web card: 2"])
  }

  @Test func theBoardPanelTakesTheCanvasThemesBackground() {
    for t in Theme.all { #expect(ShellTheme.board(t.id).components == t.canvas.components) }
    #expect(ShellTheme.board(.warmInk).components != ShellTheme.board(.inkWash).components)
  }
}

/// The cover over the top bar: the canvas colour, opaque over the bar, gone a fade's length below it
@MainActor @Test(arguments: Theme.ID.allCases) func topFadeCoversTheBarAndFadesOut(_ id: Theme.ID) throws {
  let theme = Theme.named(id)
  let img = try #require(
    TopFade.image(width: 200, bar: 36, canvas: CGSize(width: 200, height: 600), theme: theme, scale: 2))
  let srgb = try #require(CGColorSpace(name: CGColorSpace.sRGB))
  let ctx = try #require(
    CGContext(
      data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: img.width * 4, space: srgb,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
  let px = try #require(ctx.data).assumingMemoryBound(to: UInt8.self)
  /// Alpha at a y-down row
  func alpha(_ row: Int) -> UInt8 { px[row * img.width * 4 + 3] }
  #expect(img.height == 2 * (36 + Int(TopFade.length)))
  #expect(alpha(0) == 255 && alpha(71) == 255)
  #expect(alpha(img.height - 1) < 3)
  let mid = alpha(72 + Int(TopFade.length))
  #expect(mid > 60 && mid < 200)
  let c = try #require(theme.canvas.converted(to: srgb, intent: .defaultIntent, options: nil)?.components)
  let red = Double(px[0]) - Double(c[0]) * 255
  let blue = Double(px[2]) - Double(c[2]) * 255
  #expect(abs(red) < 2 && abs(blue) < 2)
}
