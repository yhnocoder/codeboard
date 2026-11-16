import Foundation
import Testing

@testable import CodeBoardModel

// The client of box (BoxService) against a fake service in the test: a Unix socket in a short temporary folder (a
// socket's path has 104 bytes at most), a token file, and a line answered per request. No real box, no network.

/// A fake box: answers hello as the service does (a wrong token: an error, and the connection ends), every other line
/// with `answer` (its result or error, the id added; nil: never answers)
final class FakeBox: @unchecked Sendable {
  let home: URL
  let token = "t0ken"
  private let socket: String
  private let fd: Int32
  private let answer: @Sendable (String, [String: Any]) -> [String: Any]?
  private let lock = NSLock()
  private var got: [String] = []
  private var clients: [Int32] = []
  private var stopped = false

  /// The lines it was sent, in order
  var lines: [String] { lock.withLock { got } }

  init(
    socketName: String = "box.sock",
    answer: @escaping @Sendable (String, [String: Any]) -> [String: Any]? = { _, _ in nil }
  ) throws {
    var template = Array("/tmp/bx.XXXXXX".utf8CString)
    let dir = try #require(mkdtemp(&template).map { String(cString: $0) })
    home = URL(filePath: dir)
    socket = "\(dir)/\(socketName)"
    self.answer = answer
    try "\(token)\n".write(to: home.appending(path: "token"), atomically: true, encoding: .utf8)
    let listening = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    fd = listening
    try #require(at(socket, { bind(listening, $0, $1) }) == 0 && listen(listening, 8) == 0)
    Thread.detachNewThread { [self] in accepting() }
  }

  private func accepting() {
    while true {
      let c = accept(fd, nil, nil)
      let done = lock.withLock {
        if !stopped, c >= 0 { clients.append(c) }
        return stopped
      }
      if done || c < 0 {
        if c >= 0 { close(c) }
        close(fd)
        return
      }
      Thread.detachNewThread { [self] in serve(c) }
    }
  }

  private func serve(_ c: Int32) {
    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 65536)
    var hello = false
    while true {
      let n = read(c, &chunk, chunk.count)
      guard n > 0 else { break }
      buffer.append(contentsOf: chunk[0..<n])
      while let nl = buffer.firstIndex(of: 0x0A) {
        let line = Data(buffer[buffer.startIndex..<nl])
        buffer = Data(buffer[(nl + 1)...])
        lock.withLock { got.append(String(decoding: line, as: UTF8.self)) }
        guard let req = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
        let op = req["op"] as? String ?? ""
        var reply: [String: Any]
        if !hello {
          guard op == "hello", req["token"] as? String == token else {
            write(c, ["id": req["id"] ?? NSNull(), "error": "say hello with the token first"])
            shutdown(c, SHUT_RDWR)
            return
          }
          hello = true
          reply = ["result": ["version": "0", "pid": 1]]
        } else {
          guard let r = answer(op, req) else { continue }
          reply = r
        }
        reply["id"] = req["id"]
        write(c, reply)
      }
    }
  }

  private func write(_ c: Int32, _ obj: [String: Any]) {
    var data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data()
    data.append(0x0A)
    _ = data.withUnsafeBytes { Darwin.write(c, $0.baseAddress!, $0.count) }
  }

  /// Stops listening, ends every connection and removes its folder
  func stop() {
    let open = lock.withLock {
      stopped = true
      return clients
    }
    for c in open { shutdown(c, SHUT_RDWR) }
    // wakes the accept, which then closes the socket
    let wake = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    _ = at(socket) { connect(wake, $0, $1) }
    close(wake)
    try? FileManager.default.removeItem(at: home)
  }
}

/// `call` with the address of the Unix socket at `path`
private func at(_ path: String, _ call: (UnsafePointer<sockaddr>, socklen_t) -> Int32) -> Int32 {
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: Array(path.utf8)) }
  return withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { call($0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
  }
}

private func json(_ line: String) throws -> [String: Any] {
  try #require(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
}

private let source = "/v"

@Suite struct BoxServiceTests {
  @Test func syncAndSearchSayHelloWithTheTokenAndUseTheProtocolsNames() async throws {
    let box = try FakeBox { op, _ in
      switch op {
      case "sync": ["result": ["accepted": 1]]
      case "search":
        [
          "result": [
            "hits": [["id": "card:a", "score": 0.7, "piece": 1, "range": [3, 9], "meta": NSNull()]], "left": 4,
            "model": "gemma", "source": source, "ref": "_",
          ]
        ]
      default: nil
      }
    }
    defer { box.stop() }
    let s = BoxService(bin: nil, home: box.home)
    let accepted = try await s.sync(
      source: source, ref: "_", embedder: BoxEmbedder(base: "http://127.0.0.1:1/v1", model: "m", key: "k"),
      items: [BoxItem(id: "card:a", title: "A", text: "the text", groups: ["b1"])])
    #expect(accepted == 1)
    let r = try await s.search(BoxQuery(source: source, ref: "_", q: "kv", k: 16, groups: ["b1"], minScore: 0.55))
    #expect(r.hits == [BoxHit(id: "card:a", score: 0.7, piece: 1, range: [3, 9])])
    #expect(r.left == 4 && r.model == "gemma" && r.unsynced == nil)

    let lines = try box.lines.map(json)
    #expect(lines.count == 4)
    #expect(lines[0]["op"] as? String == "hello" && lines[0]["token"] as? String == box.token)
    #expect(Set(lines[1].keys) == ["id", "op", "source", "ref", "embedder", "items"])
    #expect(lines[1]["op"] as? String == "sync")
    let embedder = try #require(lines[1]["embedder"] as? [String: Any])
    #expect(Set(embedder.keys) == ["base", "model", "key"])
    let item = try #require((lines[1]["items"] as? [[String: Any]])?.first)
    #expect(Set(item.keys) == ["id", "title", "text", "groups"])
    #expect(lines[2]["op"] as? String == "hello")
    #expect(Set(lines[3].keys) == ["id", "op", "source", "ref", "q", "k", "groups", "min_score"])
    #expect(lines[3]["min_score"] as? Double == 0.55)
  }

  @Test func aWrongTokenIsTheServicesError() async throws {
    let box = try FakeBox()
    defer { box.stop() }
    try "other\n".write(to: box.home.appending(path: "token"), atomically: true, encoding: .utf8)
    await #expect(throws: BoxError.service("say hello with the token first")) {
      try await BoxService(bin: nil, home: box.home).status(source: source, ref: "_")
    }
  }

  @Test func unsyncedIsSaid() async throws {
    let box = try FakeBox { _, _ in
      ["result": ["hits": [], "left": 0, "unsynced": true, "source": source, "ref": "_"]]
    }
    defer { box.stop() }
    let r = try await BoxService(bin: nil, home: box.home).search(BoxQuery(source: source, ref: "_", q: "kv"))
    #expect(r.unsynced == true)
  }

  @Test func aServiceThatDoesNotAnswerTimesOut() async throws {
    let box = try FakeBox()
    defer { box.stop() }
    await #expect(throws: BoxError.timedOut) {
      try await BoxService(bin: nil, home: box.home, timeout: .milliseconds(50)).search(
        BoxQuery(source: source, ref: "_", q: "kv"))
    }
  }

  /// The binary is started with serve and BOX_HOME when nothing listens: here a script that links the fake's socket to
  /// where box's goes, as a starting service appears there
  @Test func theServiceIsStartedWhenNoneListens() async throws {
    let box = try FakeBox(socketName: "real.sock") { op, _ in
      op == "status"
        ? ["result": ["items": 2, "pieces": 3, "left": 0, "indexing": false, "synced": true]] : nil
    }
    defer { box.stop() }
    let bin = box.home.appending(path: "box")
    try "#!/bin/sh\n[ \"$1\" = serve ] && ln -s \"$BOX_HOME/real.sock\" \"$BOX_HOME/box.sock\"\n".write(
      to: bin, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bin.path)
    let st = try await BoxService(bin: bin, home: box.home).status(source: source, ref: "_")
    #expect(st.items == 2 && st.synced)
  }

  @Test func withNoServiceAndNoBinaryItIsUnavailable() async throws {
    let box = try FakeBox(socketName: "elsewhere.sock")
    defer { box.stop() }
    await #expect(throws: BoxError.unavailable) {
      try await BoxService(bin: nil, home: box.home).status(source: source, ref: "_")
    }
  }
}
