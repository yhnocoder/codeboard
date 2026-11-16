import Foundation
import Testing

@testable import CodeBoardReading

@Suite struct WebAddressTests {
  @Test(arguments: [
    ("https://example.com/a?b=1#c", "https://example.com/a?b=1#c"),
    ("http://example.com", "http://example.com"),
    ("  HTTPS://Example.com/x  ", "HTTPS://Example.com/x"),
    ("example.com", "https://example.com"),
    ("docs.example.org/guide/intro", "https://docs.example.org/guide/intro"),
    ("example.com:8443/x", "https://example.com:8443/x"),
    ("localhost:8080", "http://localhost:8080"),
    ("localhost", "http://localhost"),
    ("127.0.0.1:5000/a", "http://127.0.0.1:5000/a"),
    ("192.168.1.20", "http://192.168.1.20"),
  ])
  func addressesAreRead(_ typed: String, _ url: String) {
    #expect(WebAddress.url(from: typed)?.absoluteString == url)
  }

  /// Words, a word alone, other schemes, a number: not addresses (nothing is searched for)
  @Test(arguments: [
    "", "   ", "what is a kernel", "kernel", "1.5", "example.c0m", "mailto:someone@example.com", "ftp://example.com",
    "file:///etc/hosts", "javascript:alert(1)", "https://", "300.1.1.1", "someone@example.com",
  ])
  func otherTextIsNotAnAddress(_ typed: String) {
    #expect(WebAddress.url(from: typed) == nil)
  }

  @Test func theBarShowsTheHost() {
    #expect(WebAddress.shown(URL(string: "https://www.example.com/a/b")) == "example.com")
    #expect(WebAddress.shown(URL(string: "http://127.0.0.1:5000/a")) == "127.0.0.1")
    #expect(WebAddress.shown(URL(string: "about:blank")) == "about:blank")
    #expect(WebAddress.shown(nil) == "")
  }

  @Test func aSuggestionShowsTheAddressWithItsPath() {
    #expect(WebAddress.withPath(URL(string: "https://www.example.com/a/b?c=1")!) == "example.com/a/b?c=1")
    #expect(WebAddress.withPath(URL(string: "http://127.0.0.1:5000/")!) == "127.0.0.1:5000")
    #expect(WebAddress.withPath(URL(string: "https://example.com")!) == "example.com")
    #expect(WebAddress.withPath(URL(string: "https://example.com/docs/")!) == "example.com/docs/")
  }
}

@Suite struct WebHistoryTests {
  let t0 = Date(timeIntervalSinceReferenceDate: 800_000_000)
  func u(_ s: String) -> URL { URL(string: s)! }

  /// A visit again counts and moves its last visit; a fragment is the same page; a page's title follows it, unless
  /// it has none
  @Test func visitsCountByPage() {
    var h = WebHistory()
    h.visit(u("https://example.com/a"), title: "A", at: t0)
    h.visit(u("https://example.com/a#part"), title: "", at: t0 + 10)
    h.visit(u("https://example.com/b"), title: nil, at: t0 + 20)
    h.visit(u("https://example.com/a"), title: "A, renamed", at: t0 + 30)
    #expect(h.entries.map(\.url.absoluteString) == ["https://example.com/a", "https://example.com/b"])
    #expect(h.entries[0].count == 3 && h.entries[0].lastVisit == t0 + 30 && h.entries[0].title == "A, renamed")
    #expect(h.entries[1].count == 1 && h.entries[1].title == "")
  }

  /// A title that comes on its own names the page without counting a visit, before the visit or after it
  @Test func aTitleAloneIsNotAVisit() {
    var h = WebHistory()
    h.visit(u("https://example.com/a"), title: "Early", at: t0, counted: false)
    h.visit(u("https://example.com/a"), title: nil, at: t0 + 1)
    h.visit(u("https://example.com/b"), title: nil, at: t0 + 2)
    h.visit(u("https://example.com/b"), title: "Late", at: t0 + 3, counted: false)
    #expect(h.entries.map(\.title) == ["Early", "Late"] && h.entries.map(\.count) == [1, 1])
    #expect(h.entries.map(\.lastVisit) == [t0 + 1, t0 + 2])
  }

  /// Past the cap the least recently visited go
  @Test func theHistoryIsCapped() {
    var h = WebHistory()
    for i in 0..<(WebHistory.cap + 5) { h.visit(u("https://example.com/\(i)"), title: nil, at: t0 + Double(i)) }
    #expect(h.entries.count == WebHistory.cap)
    let kept = Set(h.entries.map(\.url.lastPathComponent))
    #expect(!kept.contains("0") && !kept.contains("4") && kept.contains("5") && kept.contains("\(WebHistory.cap + 4)"))
  }

  /// The address's start (scheme and www. left out) comes before the host or title holding it; then the most visited,
  /// then the latest
  @Test func matchesComeBestFirst() {
    var h = WebHistory()
    h.visit(u("https://www.kernels.dev/"), title: "Kernels", at: t0)
    h.visit(u("https://blog.example.com/kernel-fusion"), title: "Fusing kernels", at: t0 + 1)
    h.visit(u("https://ker.example.org/"), title: "Ker", at: t0 + 2)
    h.visit(u("https://example.net/x"), title: "Something about KERNELS", at: t0 + 3)
    h.visit(u("https://example.net/x"), title: nil, at: t0 + 4)
    h.visit(u("https://unrelated.example/"), title: "Nothing", at: t0 + 5)
    let ker = h.matches("ker").map(\.url.absoluteString)
    #expect(
      ker == [
        "https://ker.example.org/", "https://www.kernels.dev/", "https://example.net/x",
        "https://blog.example.com/kernel-fusion",
      ])
    #expect(h.matches("kernels.dev/").map(\.url.absoluteString) == ["https://www.kernels.dev/"], "a path typed on")
    #expect(h.matches("FUSING").map(\.title) == ["Fusing kernels"], "any case")
    #expect(h.matches("").isEmpty && h.matches("  ").isEmpty && h.matches("zzz").isEmpty)
    #expect(h.matches("e", limit: 2).count == 2)
  }

  @Test func theFileRoundTripsAndAMissingOrBrokenOneIsEmpty() throws {
    let dir = FileManager.default.temporaryDirectory.appending(path: "web-history-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dir) }
    let file = dir.appending(path: "nested/history.json")
    #expect(WebHistory.read(file) == WebHistory())
    var h = WebHistory()
    h.visit(u("https://example.com/a"), title: "A", at: t0)
    try h.write(file)
    #expect(WebHistory.read(file) == h)
    try Data("not json".utf8).write(to: file)
    #expect(WebHistory.read(file) == WebHistory())
  }

  /// Visits from many tabs at once are each kept
  @Test func visitsAtOnceAreAllKept() async throws {
    let dir = FileManager.default.temporaryDirectory.appending(path: "web-history-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dir) }
    let file = dir.appending(path: "history.json")
    let t0 = t0
    await withTaskGroup(of: Void.self) { g in
      for i in 0..<20 {
        g.addTask {
          await WebHistoryFile.shared.visit(
            URL(string: "https://example.com/\(i)")!, title: "\(i)", at: t0 + Double(i), in: file)
        }
      }
    }
    #expect(await WebHistoryFile.shared.read(file).entries.count == 20)
  }
}
