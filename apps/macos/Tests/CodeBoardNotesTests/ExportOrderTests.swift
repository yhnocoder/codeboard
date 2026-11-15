import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardNotes

// Which cards an export takes and in what order: core's exportOrder run in the Note page, of the board the app imported
// from main's file, against what main itself gave (the model tests' Fixtures/export.json, tools/export/cases.mjs)

@Test @MainActor func exportOrderIsCoresOfTheImportedBoard() async throws {
  _ = NSApplication.shared
  let page = NoteRenderer.bundledPage.appending(path: "page.html").path(percentEncoded: false)
  try #require(FileManager.default.fileExists(atPath: page), "build the Note page first: node web/build.mjs")
  let fixture = URL(filePath: #filePath).deletingLastPathComponent()
    .appending(path: "../CodeBoardModelTests/Fixtures/export.json")
  let raw = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any])
  let boards = try #require(raw["boards"] as? [String: Any])
  let cases = try #require(raw["cases"] as? [[String: Any]])
  let root = FileManager.default.temporaryDirectory.appending(path: "export-order-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: root) }
  let source = root.appending(path: "storage")
  try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
  for (path, b) in boards {
    try JSONSerialization.data(withJSONObject: b).write(to: source.appending(path: path))
  }
  let vault = Vault(root: root.appending(path: "vault"))
  _ = try LegacyImport.run(from: source, to: vault.root)
  let vb = try #require(try vault.tree().allBoards.first { $0.id.rawValue == raw["board"] as? String })
  let board = try vault.board(at: vb.path)
  let r = NoteRenderer(cache: root.appending(path: "cache"))
  #expect(cases.count == 6)
  for c in cases {
    let s = try #require(c["scope"] as? [String: Any])
    let scope: ExportScope =
      switch s["kind"] as? String {
      case "sections": .sections((s["ids"] as? [String] ?? []).map { SectionID(rawValue: $0) })
      case "walk": .walk(CardID(rawValue: s["start"] as? String ?? ""))
      default: .board
      }
    let order = try await r.exportOrder(board, scope)
    #expect(order.map(\.rawValue) == c["order"] as? [String], "\(c["name"] ?? "")")
  }
}
