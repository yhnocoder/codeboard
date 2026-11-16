import Foundation
import Network

// What the web tab's tests share: the loopback server their made-up pages come from, and waiting on a page.

/// Waits for `ok`, looking again every few milliseconds; the time is only a bound
@MainActor func until(_ what: String, _ ok: () async throws -> Bool) async throws {
  let end = ContinuousClock.now + .seconds(15)
  while try await !ok() {
    guard ContinuousClock.now < end else { throw Timeout(what: what) }
    try await Task.sleep(for: .milliseconds(10))
  }
}

struct Timeout: Error { var what: String }

/// An HTTP/1.1 server on 127.0.0.1 at a free port, one request per connection, answering from `pages`
final class LoopbackServer: Sendable {
  struct Request: Sendable {
    var method: String
    var path: String
    /// By lowercased name
    var headers: [String: String]
  }

  struct Response: Sendable {
    var status = "200 OK"
    var headers: [String: String] = [:]
    var body: String

    static func html(_ body: String, headers: [String: String] = [:]) -> Response {
      Response(headers: headers, body: "<!doctype html><meta charset='utf-8'>" + body)
    }
  }

  private let listener: NWListener
  let port: UInt16
  private let queue = DispatchQueue(label: "loopback-server")

  init(pages: @escaping @Sendable (Request) -> Response) async throws {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
    let listener = try NWListener(using: params)
    let queue = queue
    listener.newConnectionHandler = { c in
      c.start(queue: queue)
      Self.read(c, Data(), pages)
    }
    port = try await withCheckedThrowingContinuation { (k: CheckedContinuation<UInt16, any Error>) in
      listener.stateUpdateHandler = { state in
        switch state {
        case .ready:
          listener.stateUpdateHandler = nil
          k.resume(returning: listener.port?.rawValue ?? 0)
        case .failed(let e):
          listener.stateUpdateHandler = nil
          k.resume(throwing: e)
        default: break
        }
      }
      listener.start(queue: queue)
    }
    self.listener = listener
  }

  deinit { listener.cancel() }

  private static func read(_ c: NWConnection, _ had: Data, _ pages: @escaping @Sendable (Request) -> Response) {
    c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { chunk, _, done, error in
      let got = had + (chunk ?? Data())
      guard let end = got.range(of: Data("\r\n\r\n".utf8)) else {
        if done || error != nil { c.cancel() } else { read(c, got, pages) }
        return
      }
      let head = String(decoding: got[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
      let start = head[0].split(separator: " ").map(String.init)
      var headers: [String: String] = [:]
      for line in head.dropFirst() {
        guard let colon = line.firstIndex(of: ":") else { continue }
        headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      }
      let length = Int(headers["content-length"] ?? "") ?? 0
      guard got.count - end.upperBound >= length || done else { return read(c, got, pages) }
      let r = pages(Request(method: start[0], path: start.count > 1 ? start[1] : "/", headers: headers))
      let body = Data(r.body.utf8)
      var lines = ["HTTP/1.1 \(r.status)", "Content-Type: text/html; charset=utf-8", "Content-Length: \(body.count)"]
      lines += ["Connection: close"] + r.headers.map { "\($0.key): \($0.value)" }
      let answer = Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8) + body
      c.send(content: answer, completion: .contentProcessed { _ in c.cancel() })
    }
  }
}
