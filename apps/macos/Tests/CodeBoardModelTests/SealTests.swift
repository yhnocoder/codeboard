import Foundation
import Testing

@testable import CodeBoardModel

// The port of seal.ts against seal.ts itself: Fixtures/seal.json holds names, ids and typed seals and what the
// TypeScript made of them (tools/seal/cases.mjs writes it)

private struct Cases: Decodable {
  struct Text: Decodable {
    var name: String
    var text: String
  }
  struct Clean: Decodable {
    var text: String
    var clean: String
    var ok: Bool
  }
  struct Colour: Decodable {
    var id: String
    var color: String
  }
  struct Out: Decodable {
    var text: String
    var color: String
  }
  struct Kept: Decodable {
    var text: String?
    var color: String?
  }
  struct Of: Decodable {
    var id: String
    var name: String
    var seal: Kept?
    var out: Out
  }
  struct Keep: Decodable {
    var id: String
    var name: String
    var text: String
    var color: String
    var out: Kept?
  }
  var defaultText: [Text]
  var clean: [Clean]
  var color: [Colour]
  var sealOf: [Of]
  var keep: [Keep]

  static func load() throws -> Cases { try JSONDecoder().decode(Cases.self, from: try fixture("seal.json")) }
}

@Test func defaultSealTextsMatchSealTS() throws {
  let c = try Cases.load()
  #expect(c.defaultText.count >= 30)
  for t in c.defaultText { #expect(Seal.defaultText(t.name) == t.text, "\(t.name)") }
}

@Test func cleaningAndCheckingSealTextsMatchSealTS() throws {
  for t in try Cases.load().clean {
    #expect(Seal.clean(t.text) == t.clean, "\(t.text)")
    #expect(Seal.isText(t.text) == t.ok, "\(t.text)")
  }
}

@Test func defaultSealColoursMatchSealTS() throws {
  let c = try Cases.load()
  #expect(Set(c.color.map(\.color)).count == 8, "every colour comes up")
  for t in c.color { #expect(Seal.defaultColor(BoardID(rawValue: t.id)).rawValue == t.color, "\(t.id)") }
}

@Test func sealsShownAndKeptMatchSealTS() throws {
  let c = try Cases.load()
  for t in c.sealOf {
    let own = t.seal.map { Seal(text: $0.text, color: $0.color.flatMap(Seal.Color.init(rawValue:))) }
    let got = Seal.of(id: BoardID(rawValue: t.id), name: t.name, seal: own)
    #expect(got.text == t.out.text && got.color.rawValue == t.out.color, "\(t.name) \(String(describing: t.seal))")
  }
  for t in c.keep {
    let got = Seal.keep(
      id: BoardID(rawValue: t.id), name: t.name, text: t.text, color: Seal.Color(rawValue: t.color)!)
    #expect(got?.text == t.out?.text && got?.color?.rawValue == t.out?.color, "\(t.name) \(t.text) \(t.color)")
  }
}
