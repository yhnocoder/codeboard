import Foundation
import Testing

@testable import CodeBoardModel

// The port of migrate.ts against migrate.ts itself: Fixtures/upgrade.json holds old files and what the TypeScript made of
// them (tools/legacy-upgrade/cases.mjs writes it)

private struct Cases: @unchecked Sendable {
  let boards: [NSDictionary]
  let shared: [NSDictionary]
  let titled: [NSDictionary]

  init() throws {
    let raw = try JSONSerialization.jsonObject(with: try fixture("upgrade.json")) as! NSDictionary
    boards = raw["boards"] as! [NSDictionary]
    shared = raw["shared"] as! [NSDictionary]
    titled = raw["titled"] as! [NSDictionary]
  }
}

/// A fresh mutable copy, as the importer reads a file
private func mutable(_ v: Any) throws -> NSMutableDictionary {
  try JSONSerialization.jsonObject(
    with: JSONSerialization.data(withJSONObject: v), options: [.mutableContainers]) as! NSMutableDictionary
}

/// Where two JSON values first differ, or nil
private func difference(_ a: Any?, _ b: Any?, at path: String = "") -> String? {
  if let x = a as? NSDictionary, let y = b as? NSDictionary {
    let keys = Set((x.allKeys + y.allKeys).compactMap { $0 as? String }).sorted()
    for k in keys { if let d = difference(x[k], y[k], at: "\(path).\(k)") { return d } }
    return nil
  }
  if let x = a as? NSArray, let y = b as? NSArray {
    if x.count != y.count { return "\(path): \(x.count) items, expected \(y.count)" }
    for i in 0..<x.count { if let d = difference(x[i], y[i], at: "\(path)[\(i)]") { return d } }
    return nil
  }
  let text = { (v: Any?) -> String in
    guard let v else { return "nothing" }
    guard let data = try? JSONSerialization.data(withJSONObject: [v], options: [.fragmentsAllowed]) else {
      return "\(v)"
    }
    return String(decoding: data, as: UTF8.self)
  }
  return text(a) == text(b) ? nil : "\(path): \(text(a)), expected \(text(b))"
}

@Test func boardUpgradeMatchesMigrateTS() throws {
  let cases = try Cases()
  #expect(cases.boards.count == 5)
  for c in cases.boards {
    let got = LegacyUpgrade.board(try mutable(c["input"]!))
    #expect(difference(got, c["output"]) == nil, "\(c["name"]!)")
  }
}

@Test func sharedCardUpgradeMatchesMigrateTS() throws {
  let cases = try Cases()
  #expect(cases.shared.count == 20)
  for c in cases.shared {
    let got = LegacyUpgrade.sharedCard(try mutable(c["input"]!))
    #expect(difference(got, c["output"]) == nil, "\(c["name"]!)")
  }
}

@Test func referencesToLibraryCardsTakeTheirTitles() throws {
  let cases = try Cases()
  for (i, c) in cases.titled.enumerated() {
    let input = cases.boards[i]["input"] as! NSDictionary
    let version = input["version"] as! Int
    var library: [String: NSDictionary] = [:]
    for s in cases.shared where (s["input"] as! NSDictionary)["version"] as? Int == version {
      let card = LegacyUpgrade.sharedCard(try mutable(s["input"]!))["card"] as! NSDictionary
      library[card["id"] as! String] = card
    }
    let b = LegacyUpgrade.board(try mutable(input))
    LegacyUpgrade.titleRefs(b, version: version, shared: library)
    #expect(difference(b["sidenotes"], c["sidenotes"]) == nil, "\(c["name"]!)")
  }
}

@Test func markTagsInSmallPieces() {
  // the cases migrate.ts's own tests start from
  #expect(LegacyUpgrade.markTags("a <mark>b</mark> c") == "a ==b== c")
  #expect(LegacyUpgrade.markTags("`<mark>x</mark>`") == "`<mark>x</mark>`")
  #expect(LegacyUpgrade.markTags("<mark> padded </mark>") == " ==padded== ")
  #expect(LegacyUpgrade.markTags("x\n```\n<mark>y</mark>\n```") == "x\n```\n<mark>y</mark>\n```")
}

@Test func referencesAreRewrittenOutsideCode() {
  let md = "[[A#^x]] `[[A#^x]]`\n```\n[[A#^x]]\n```\n[[ B #^y]] [[#^z]]"
  let got = LegacyUpgrade.mapRefs(md) { label, target in "<\(label)|\(target ?? "-")>" }
  #expect(got == "<A|x> `[[A#^x]]`\n```\n[[A#^x]]\n```\n<B|y> [[#^z]]")
  #expect(LegacyUpgrade.refSource(" [a]\nb ", "c1") == "[[a  b#^c1]]")
  #expect(LegacyUpgrade.refSource("", "c1") == "[[Card#^c1]]")
}

@Test func hostnamesAsJavaScriptsURLGivesThem() {
  // what node's new URL(s).hostname gives (nil: it throws)
  let cases: [(String, String?)] = [
    ("HTTPS://WWW.Example.COM/x", "www.example.com"), ("http://user:pw@Host.Example:8080/p?q#f", "host.example"),
    ("mailto:someone@example.org", ""), ("foo://Bar.Example/x", "Bar.Example"), ("file:///tmp/x", ""),
    ("file://Srv/x", "srv"), ("https://Bücher.Example/", "xn--bcher-kva.example"), ("http://", nil),
    ("  https://www.trim.example  ", "www.trim.example"), ("https:\\\\back.example\\x", "back.example"),
    ("https://a%2Eb.example/", "a.b.example"), ("https://exa mple.com/", nil), ("http://[::1]:80/", "[::1]"),
    ("not a url", nil), ("https://例え.テスト/", "xn--r8jz45g.xn--zckzah"),
  ]
  for (url, host) in cases { #expect(JSURL.hostname(url) == host, "\(url)") }
}
