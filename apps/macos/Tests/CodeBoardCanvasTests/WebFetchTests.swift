import Foundation
import Testing

@testable import CodeBoardCanvas

// Reading a page (host/src/web.ts) without the network: its head parsed as the web board's host parses it, and the
// whole read through a URL protocol that answers from memory

/// Answers every request from `StubProtocol.pages`, by absolute URL
final class StubProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var pages: [String: (status: Int, type: String, body: Data, location: String?)] = [:]

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let url = request.url!.absoluteString
    guard let p = StubProtocol.pages[url] else {
      client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
      return
    }
    var headers = ["Content-Type": p.type]
    if let l = p.location { headers["Location"] = l }
    let resp = HTTPURLResponse(url: request.url!, statusCode: p.status, httpVersion: "HTTP/1.1", headerFields: headers)!
    if let l = p.location, let to = URL(string: l) {
      client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: to), redirectResponse: resp)
      return
    }
    client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: p.body)
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}

  static var session: URLSession {
    let c = URLSessionConfiguration.ephemeral
    c.protocolClasses = [StubProtocol.self]
    return URLSession(configuration: c)
  }
}

/// A 2 × 1 PNG
let tinyPNG = Data(
  base64Encoded:
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwH4QBEfcD/ePF9e8AAAAASUVORK5CYII=")!

@Suite(.serialized) struct WebFetchTests {
  @Test func theFirstMetaOfEachWinsAndAddressesAreResolvedAgainstTheBase() {
    let html = """
      <html><head><base href="https://cdn.example.com/a/">
      <title>  The   &amp; Page </title>
      <meta property="og:title" content="Open Graph &#x2014; title">
      <meta property="og:title" content="second">
      <meta name="description" content="\(String(repeating: "x", count: 400))">
      <meta property="og:site_name" content="Example">
      <meta property="og:image" content="pic.png">
      <link rel="icon" href="/i16.png" sizes="16x16"><link rel="apple-touch-icon" href="/apple.png">
      <link rel="icon" href="/i32.png" sizes="32x32">
      </head>
      """
    let m = WebFetcher.parse(html, base: URL(string: "https://example.com/post")!)
    #expect(m.title == "Open Graph — title" && m.site == "Example")
    #expect(m.description?.count == 318 && m.description?.hasSuffix("…") == true)
    #expect(m.image?.absoluteString == "https://cdn.example.com/a/pic.png")
    // the one nearest 32 first, the apple one after its size's others, /favicon.ico last
    #expect(
      m.icons.map(\.absoluteString) == [
        "https://cdn.example.com/i32.png", "https://cdn.example.com/i16.png", "https://cdn.example.com/apple.png",
        "https://cdn.example.com/favicon.ico",
      ])
    // no og:title: the <title>, its spaces collapsed
    let t = WebFetcher.parse("<title>  The   &amp; Page </title>", base: URL(string: "https://e.com")!)
    #expect(t.title == "The & Page")
  }

  @Test func aPageIsReadWithItsPictureAndIconAndAFailedOneSaysSo() async {
    StubProtocol.pages = [
      "https://site.test/post": (
        200, "text/html; charset=utf-8",
        Data(
          "<head><meta property=\"og:title\" content=\"Hi\"><meta property=\"og:image\" content=\"/p.png\"></head><body>"
            .utf8), nil
      ),
      "https://site.test/p.png": (200, "image/png", tinyPNG, nil),
      "https://site.test/favicon.ico": (200, "image/png", tinyPNG, nil),
      "https://site.test/data.json": (200, "application/json", Data("{}".utf8), nil),
      "https://site.test/private": (302, "text/html", Data(), "https://site.test/login?next=1"),
      "https://site.test/login?next=1": (
        200, "text/html", Data("<title>Sign in</title>".utf8), nil
      ),
      "https://site.test/gone": (404, "text/html", Data(), nil),
    ]
    let s = StubProtocol.session
    let p = await WebFetcher.fetch(URL(string: "https://site.test/post")!, session: s)
    #expect(p.title == "Hi" && !p.failed && p.image?.ext == "png" && p.icon?.ext == "png")
    #expect(p.image?.name.count == 20 && p.image?.name.hasSuffix(".png") == true)
    for bad in ["data.json", "private", "gone", "nowhere"] {
      let f = await WebFetcher.fetch(URL(string: "https://site.test/\(bad)")!, session: s)
      #expect(f.failed && f.title == nil, "\(bad)")
    }
  }

  @Test func picturesAreKnownByTheirBytes() {
    #expect(WebFetcher.sniff(tinyPNG) == "png")
    #expect(WebFetcher.sniff(Data([0xFF, 0xD8, 0xFF, 0xE0])) == "jpeg")
    #expect(WebFetcher.sniff(Data("<?xml?><svg xmlns=''>".utf8)) == "svg")
    #expect(WebFetcher.sniff(Data("hello".utf8)) == nil)
  }
}
