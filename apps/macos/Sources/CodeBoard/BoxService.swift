// box, the index behind ⌘K: the same service the VS Code extension uses (packages/box, PROTOCOL.md), so the app and every VS
// Code window share one index and nothing is embedded twice. As the TypeScript client does (packages/box/src/index.ts
// connect()): `box home` names the socket and token file, a request dials the socket (starting `box serve` from the binary
// in the app bundle when nothing listens) and says hello with the token. One connection per request, off the main thread.
import Foundation

struct Embedder: Codable {
  var base: String
  var model: String?
  var key: String?
}
struct BoxHit: Decodable {
  var id: String
  var score: Double
  var piece: Int?
  var range: [Int]?
  var picture: String?
}
struct SearchResult: Decodable {
  var hits: [BoxHit]
  var left: Int?
  var error: String?
  var unsynced: Bool?
  var model: String?
  var superseded: Bool?
}
struct BoxStatus: Decodable {
  var items: Int
  var pieces: Int
  var model: String?
  var left: Int
  var indexing: Bool
  var error: String?
}
struct BoxError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

final class BoxService: @unchecked Sendable {
  let bin: String
  private let lock = NSLock()
  private var paths: (socket: String, token: String)?
  /** How long a just started service has to listen (the TS client's START_WAIT) */
  private static let startWait = 5.0

  init(bin: String) { self.bin = bin }

  func request<T: Decodable>(_ op: String, _ body: [String: Any], as: T.Type = T.self) async throws -> T {
    try await withCheckedThrowingContinuation { c in
      DispatchQueue.global(qos: .userInitiated).async {
        c.resume(with: Result { try self.blocking(op, body) })
      }
    }
  }

  func sync(source: String, ref: String, embedder: Embedder, items: [[String: Any]]) async throws {
    struct Accepted: Decodable { var accepted: Int }
    let e = try JSONSerialization.jsonObject(with: JSONEncoder().encode(embedder))
    _ = try await request("sync", ["source": source, "ref": ref, "embedder": e, "items": items], as: Accepted.self)
  }
  func search(_ op: String, source: String, ref: String, q: String, k: Int, minScore: Double? = nil, model: String? = nil) async throws -> SearchResult {
    var f: [String: Any] = ["source": source, "ref": ref, "q": q, "k": k]
    if let minScore { f["min_score"] = minScore }
    if let model { f["model"] = model }
    return try await request(op, f)
  }
  func status(source: String, ref: String) async throws -> BoxStatus { try await request("status", ["source": source, "ref": ref]) }
  func forget(source: String) async throws {
    struct Empty: Decodable {}
    _ = try await request("forget", ["source": source], as: Empty.self)
  }

  // MARK: the socket

  private func blocking<T: Decodable>(_ op: String, _ body: [String: Any]) throws -> T {
    let p = try where_()
    let fd = try dialOrStart(p.socket)
    defer { close(fd) }
    let token = (try? String(contentsOfFile: p.token, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    _ = try exchange(fd, ["op": "hello", "id": 0, "token": token])
    var b = body
    b["op"] = op
    b["id"] = 1
    let result = try exchange(fd, b)
    return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: result, options: .fragmentsAllowed))
  }

  /** `box home`: the socket and the token file, once */
  private func where_() throws -> (socket: String, token: String) {
    lock.lock()
    defer { lock.unlock() }
    if let paths { return paths }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: bin)
    p.arguments = ["home"]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { throw BoxError(message: "Cannot run box (\(bin)): \(error.localizedDescription)") }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    guard let o = try JSONSerialization.jsonObject(with: data) as? [String: Any], let socket = o["socket"] as? String,
      let tokenFile = o["token"] as? String
    else { throw BoxError(message: "box home said nothing usable") }
    // the token file is the service's: read at each connection (a new service writes a new one)
    let r = (socket, tokenFile)
    paths = (r.0, r.1)
    return r
  }

  private func dial(_ path: String) -> Int32? {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8CString)
    guard bytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { close(fd); return nil }
    withUnsafeMutableBytes(of: &addr.sun_path) { dst in bytes.withUnsafeBytes { dst.copyMemory(from: $0) } }
    let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    if ok != 0 { close(fd); return nil }
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    return fd
  }

  private func dialOrStart(_ path: String) throws -> Int32 {
    if let fd = dial(path) { return fd }
    lock.lock()
    defer { lock.unlock() }
    if let fd = dial(path) { return fd }  // another request started it meanwhile
    // detached: it outlives the app and exits by itself after its idle time, as the extension's does
    let p = Process()
    p.executableURL = URL(fileURLWithPath: bin)
    p.arguments = ["serve"]
    p.standardInput = FileHandle.nullDevice
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try p.run()
    let until = Date().addingTimeInterval(BoxService.startWait)
    var pause = 0.01
    while Date() < until {
      if let fd = dial(path) { return fd }
      Thread.sleep(forTimeInterval: pause)
      pause = min(0.2, pause * 2)
    }
    throw BoxError(message: "box did not start")
  }

  /** One request line out, its answer line back: the result, or the request's error thrown */
  private func exchange(_ fd: Int32, _ body: [String: Any]) throws -> Any {
    var line = try JSONSerialization.data(withJSONObject: body)
    line.append(0x0a)
    try line.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
      var off = 0
      while off < buf.count {
        let n = write(fd, buf.baseAddress! + off, buf.count - off)
        if n <= 0 { throw BoxError(message: "box closed the connection") }
        off += n
      }
    }
    var got = Data()
    var chunk = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = read(fd, &chunk, chunk.count)
      if n <= 0 { throw BoxError(message: "box closed the connection") }
      if let nl = chunk[0..<n].firstIndex(of: 0x0a) {
        got.append(contentsOf: chunk[0..<nl])
        break
      }
      got.append(contentsOf: chunk[0..<n])
    }
    let o = try JSONSerialization.jsonObject(with: got) as? [String: Any] ?? [:]
    if let e = o["error"] as? String { throw BoxError(message: e) }
    return o["result"] ?? [:]
  }
}
