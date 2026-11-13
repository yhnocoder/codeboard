import Foundation
import Testing

@testable import CodeBoardModel

/// The importer's upgrade of version 13–15 files against what the extension's migrate.ts makes of the same files
/// (Fixtures/upgrade.json, written by tools/legacy-upgrade/cases.mjs): every field the importer reads off a card and its
/// place comes out the same. The cases: `<mark>` where it becomes `==` and where it stays (code spans, formulas, fences in
/// lists and quotes, HTML blocks, indented code, escapes, == around it), every old look (Text levels and bold, Free Text
/// levels with markup escaped, Mark and Box sizes), descriptions and merged cards, shared cards
@Suite struct LegacyUpgradeTests {
  struct Fixture {
    var boards: [[String: Any]]
    var shared: [[String: Any]]
  }

  nonisolated(unsafe) static let fixture: Fixture = {
    let url = Bundle.module.url(forResource: "upgrade", withExtension: "json", subdirectory: "Fixtures")!
    let o = try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    return Fixture(boards: o["boards"] as! [[String: Any]], shared: o["shared"] as! [[String: Any]])
  }()

  /// A field as the fixture writes it: null when absent, numbers as Double
  static func value(_ v: Any?) -> String {
    switch v {
    case nil, is NSNull: "null"
    case let n as NSNumber where CFGetTypeID(n) == CFBooleanGetTypeID(): n.boolValue ? "true" : "false"
    case let n as NSNumber: "\(n.doubleValue)"
    case let d as Double: "\(d)"
    case let b as Bool: b ? "true" : "false"
    case let s as String: s.debugDescription
    default: "\(v!)"
    }
  }

  static let fields = ["look", "md", "desc", "fs", "wrap", "fill"]

  @Test func boardsComeOutAsMigrateTsMakesThem() throws {
    #expect(Self.fixture.boards.count == 4)
    for b in Self.fixture.boards {
      let from = b["from"] as! Int
      var input = b["input"] as! [String: Any]
      LegacyUpgrade.board(&input, from: from)
      #expect(input["version"] as? Int == (from < 16 ? 16 : from))
      let got = input["cards"] as! [[String: Any]]
      let want = b["cards"] as! [[String: Any]]
      #expect(got.count == want.count)
      for (g, w) in zip(got, want) {
        for f in Self.fields {
          #expect(Self.value(g[f]) == Self.value(w[f]), "v\(from) card \(w["id"]!) \(f)")
        }
        let gm = (g["mergedFrom"] as? [[String: Any]])?.map { Self.value(($0["card"] as? [String: Any])?["md"]) }
        let wm = (w["mergedFrom"] as? [[String: Any]])?.map { Self.value($0["md"]) }
        #expect(gm == wm, "v\(from) card \(w["id"]!) mergedFrom")
      }
      let place = input["place"] as! [String: Any]
      for (id, p) in b["place"] as! [String: [String: Any]] {
        #expect(
          Self.value((place[id] as? [String: Any])?["h"]) == Self.value(p["h"]), "v\(from) place \(id).h")
      }
    }
  }

  @Test func sharedCardsComeOutAsMigrateTsMakesThem() {
    #expect(!Self.fixture.shared.isEmpty)
    for s in Self.fixture.shared {
      let from = s["from"] as! Int
      var input = s["input"] as! [String: Any]
      LegacyUpgrade.sharedCard(&input, from: from)
      #expect(input["version"] as? Int == 16)
      let g = input["card"] as! [String: Any]
      let w = s["card"] as! [String: Any]
      for f in Self.fields where f != "desc" {
        #expect(Self.value(g[f]) == Self.value(w[f]), "shared v\(from) \(w["id"]!) \(f)")
      }
    }
  }
}
