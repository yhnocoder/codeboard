import Foundation
import WebKit

/// Tidy Up's layout: core's tidy (ELK) as the web board runs it (web/src/tidy.ts, built as tidy.js), in a web view of its
/// own that is never shown, made and loaded the first time it is used and kept
@MainActor
public enum Tidy {
  public struct Rect: Codable, Equatable, Sendable {
    public var id: String?
    public var x, y, w, h: Double
    public init(id: String? = nil, _ r: CGRect) {
      self.id = id
      (x, y, w, h) = (r.minX, r.minY, r.width, r.height)
    }
  }

  public struct Point: Codable, Equatable, Sendable {
    public var x, y: Double
  }

  /// The script, read once
  static let script = NoteRenderer.bundledPage.appending(path: "tidy.js")
  private static var view: WKWebView?

  /// Each rect's new top left, by id: `links` between rect ids, `fixed` what must not move (locked), `avoid` what is beside
  /// them; nil when the layout could not run
  public static func layout(_ rects: [Rect], links: [[String]], fixed: [Rect], avoid: [Rect]) async -> [String: Point]?
  {
    struct Ask: Encodable {
      var cards: [Rect]
      var links: [[String]]
      var fixed: [Rect]
      var avoid: [Rect]
    }
    guard
      let ask = try? String(
        decoding: JSONEncoder().encode(Ask(cards: rects, links: links, fixed: fixed, avoid: avoid)), as: UTF8.self)
    else { return nil }
    let v: WKWebView
    var src = ""
    if let made = view {
      v = made
    } else {
      guard let s = try? String(contentsOf: script, encoding: .utf8) else { return nil }
      v = WKWebView(frame: .zero)
      view = v
      src = s
    }
    let js = """
      if (src) (0, eval)(src);
      return JSON.stringify(await tidyUp(JSON.parse(ask)));
      """
    guard
      let out = try? await v.callAsyncJavaScript(js, arguments: ["src": src, "ask": ask], contentWorld: .page)
        as? String
    else { return nil }
    return try? JSONDecoder().decode([String: Point].self, from: Data(out.utf8))
  }
}
