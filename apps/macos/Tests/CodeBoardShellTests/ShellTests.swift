import AppKit
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

/// The glass under the tabs: blurring what is behind it in the window whether or not the window is key, whole over the
/// bar and gone a dissolve's length below it, the material and its canvas-coloured tint along the same curve
@MainActor
@Test(arguments: Theme.ID.allCases, [TopGlass.Look(), TopGlass.Look(material: .hudWindow, tint: 0.3, dissolve: 30)])
func topGlassFrostsTheBarAndDissolvesBelowIt(_ id: Theme.ID, _ look: TopGlass.Look) throws {
  let theme = Theme.named(id)
  let bar: CGFloat = 36
  let d = look.dissolve
  let glass = TopGlass(frame: NSRect(x: 0, y: 0, width: 200, height: bar + d))
  glass.theme = theme
  glass.look = look
  glass.place(bar: bar)
  #expect(glass.blendingMode == .withinWindow && glass.state == look.state && glass.material == look.material)

  // the mask as the material stretches it over the glass, y-down
  let mask = try #require(glass.maskImage)
  let rep = try #require(
    NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: 10, pixelsHigh: Int(bar + d), bitsPerSample: 8, samplesPerPixel: 4,
      hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  mask.draw(in: NSRect(x: 0, y: 0, width: 10, height: bar + d))
  NSGraphicsContext.restoreGraphicsState()
  func alpha(_ row: Int) -> CGFloat { rep.colorAt(x: 5, y: row)?.alphaComponent ?? -1 }
  #expect(alpha(0) > 0.99 && alpha(Int(bar) - 1) > 0.99)
  #expect(abs(alpha(Int(bar + d / 2)) - 0.5) < 0.15)
  #expect(alpha(Int(bar + d) - 1) < 0.05)

  let tint = try #require(glass.subviews.first?.layer as? CAGradientLayer)
  let colors = try #require(tint.colors as? [CGColor])
  let locations = try #require(tint.locations).map { CGFloat($0.doubleValue) }
  let top = try #require(colors.first)
  #expect(top.copy(alpha: 1)?.components == theme.canvas.components)
  #expect(abs(top.alpha - look.tint) < 0.001)
  #expect(colors.last?.alpha == 0 && locations.last == 1)
  // whole over the bar, then down without a step
  let barEnd = try #require(locations.firstIndex { $0 >= bar / (bar + d) - 0.001 })
  #expect(abs(colors[barEnd].alpha - look.tint) < 0.001)
  #expect(zip(colors, colors.dropFirst()).allSatisfy { $1.alpha <= $0.alpha })
  #expect(zip(colors, colors.dropFirst()).allSatisfy { $0.alpha - $1.alpha < 0.3 * look.tint })
}

/// The tuned glass is kept across launches, and Reset goes back to the compiled look and stores nothing
@MainActor @Test func tunedGlassIsKeptAndResetRestoresTheDefaults() async throws {
  let suite = "glass-\(UUID())"
  let defaults = try #require(UserDefaults(suiteName: suite))
  defer { defaults.removePersistentDomain(forName: suite) }
  let tuned = TopGlass.Look(
    material: .hudWindow, tint: 0.55, dissolve: 18, emphasized: true, state: .followsWindowActiveState)
  let shell = Shell()
  let tuning = GlassTuning(shell: shell, defaults: defaults)
  #expect(shell.glass == TopGlass.Look())
  shell.glass = tuned
  for _ in 0..<100 where defaults.data(forKey: GlassTuning.key) == nil { await Task.yield() }
  let relaunched = Shell()
  _ = GlassTuning(shell: relaunched, defaults: defaults)
  #expect(relaunched.glass == tuned)
  #expect(
    GlassTuning.line(tuned) == "material=hudWindow tint=0.55 dissolve=18 emphasized=true state=followsWindowActiveState"
  )

  tuning.reset()
  #expect(shell.glass == TopGlass.Look())
  for _ in 0..<100 where defaults.data(forKey: GlassTuning.key) != nil { await Task.yield() }
  #expect(defaults.data(forKey: GlassTuning.key) == nil)
}
