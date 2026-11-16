import CodeBoardResources
import Foundation
import WebKit

extension WebReading {
  /// The app's own scheme for saved pages, `codeboard-page://<hash>/`
  static let savedScheme = "codeboard-page"

  static func savedURL(_ hash: String) -> URL { URL(string: "\(savedScheme)://\(hash)/")! }

  /// A saved page shows only what it holds inline or as data: no script, nothing fetched. No sandbox: it would keep
  /// events from the reader's script
  static let savedPolicy = "default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:"
}

/// Serves saved pages from the saving service, under the saved page policy
@MainActor final class SavedPageHandler: NSObject, WKURLSchemeHandler {
  private let store: (any PageStore)?
  /// The requests WebKit has not stopped, which alone may still be answered
  private var running: Set<ObjectIdentifier> = []

  init(store: (any PageStore)?) { self.store = store }

  func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
    let id = ObjectIdentifier(task)
    running.insert(id)
    let url = task.request.url ?? WebReading.savedURL("")
    let store = store
    Task {
      let (status, body) = await Self.page(url, from: store)
      guard running.remove(id) != nil else { return }
      let headers = ["Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": WebReading.savedPolicy]
      task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!)
      task.didReceive(body)
      task.didFinish()
    }
  }

  func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) { running.remove(ObjectIdentifier(task)) }

  /// The page written out by the service and read off the main thread; a page that says so when it is not on this Mac
  @concurrent private static func page(_ url: URL, from store: (any PageStore)?) async -> (Int, Data) {
    let missing = Data(
      """
      <!doctype html><meta charset="utf-8">
      <p style="font: 14px -apple-system, sans-serif; color: gray; margin: 48px; text-align: center">
      This saved page is not on this Mac.</p>
      """.utf8)
    guard let hash = url.host(), !hash.isEmpty, hash.allSatisfy(\.isHexDigit), url.path() == "/", let store else {
      return (404, missing)
    }
    let file = FileManager.default.temporaryDirectory.appending(path: "codeboard-page-\(UUID().uuidString).html")
    defer { try? FileManager.default.removeItem(at: file) }
    do {
      _ = try await store.writePage(hash: hash, to: file)
      return (200, try Data(contentsOf: file))
    } catch {
      return (404, missing)
    }
  }
}
