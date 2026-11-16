import Foundation

// The client of box, the per-user index service behind ⌘K's Related by Meaning (packages/box: PROTOCOL.md, src/index.ts),
// the same service VS Code's windows share. One connection per request: connect to `<home>/box.sock`, hello with the
// token in `<home>/token`, one line out, one line in, close. When no service listens it starts one from its binary
// (detached: it outlives the app and exits by itself after 10 idle minutes) and waits for it to listen.

/// An item of a source: a card or a sidenote
public struct BoxItem: Codable, Equatable, Sendable {
  public var id: String
  public var title: String
  public var text: String
  /// What a search can be narrowed to: the boards the item is on
  public var groups: [String]

  public init(id: String, title: String, text: String, groups: [String]) {
    self.id = id
    self.title = title
    self.text = text
    self.groups = groups
  }
}

/// An OpenAI-compatible embedding endpoint; the key is handed to the service with every sync and kept in its memory only
public struct BoxEmbedder: Codable, Equatable, Sendable {
  public var base: String
  public var model: String?
  public var key: String?

  public init(base: String, model: String? = nil, key: String? = nil) {
    self.base = base
    self.model = model
    self.key = key
  }
}

/// search's and rerank's question
public struct BoxQuery: Codable, Equatable, Sendable {
  public var source: String
  public var ref: String
  public var q: String
  public var k: Int?
  /// Only items in any of these groups
  public var groups: [String]?
  public var minScore: Double?
  /// rerank only: the reranking model; nil: the first the embedding server lists with "rerank" in its name
  public var model: String?

  enum CodingKeys: String, CodingKey {
    case source, ref, q, k, groups, model
    case minScore = "min_score"
  }

  public init(
    source: String, ref: String, q: String, k: Int? = nil, groups: [String]? = nil, minScore: Double? = nil,
    model: String? = nil
  ) {
    self.source = source
    self.ref = ref
    self.q = q
    self.k = k
    self.groups = groups
    self.minScore = minScore
    self.model = model
  }
}

public struct BoxHit: Codable, Equatable, Sendable {
  public var id: String
  public var score: Double
  /// Which of the item's pieces matched: 0 the whole item, then its paragraphs
  public var piece: Int
  /// A text piece: where it is in the item's text (UTF-16 offsets)
  public var range: [Int]?
  /// An image piece: its key (none are indexed from the Mac)
  public var picture: String?
  /// rerank only: the embedding server's relevance score of a hit its reranker read
  public var rerank: Double?

  public init(
    id: String, score: Double, piece: Int = 0, range: [Int]? = nil, picture: String? = nil, rerank: Double? = nil
  ) {
    self.id = id
    self.score = score
    self.piece = piece
    self.range = range
    self.picture = picture
    self.rerank = rerank
  }
}

/// search's and rerank's answer
public struct BoxResult: Codable, Equatable, Sendable {
  public var hits: [BoxHit]
  /// Pieces still to embed
  public var left: Int?
  /// The last indexing error, or why this search could not run
  public var error: String?
  /// The service has no endpoint for this source (it started since the last sync): sync, then ask again
  public var unsynced: Bool?
  /// The model fingerprint the scores come from
  public var model: String?
  /// rerank only: how many of the first hits the reranker read
  public var reranked: Int?
  /// rerank only: a newer rerank of the same source began first, so this one has no hits
  public var superseded: Bool?
  public var source: String
  public var ref: String

  public init(
    hits: [BoxHit], left: Int? = 0, error: String? = nil, unsynced: Bool? = nil, model: String? = nil,
    reranked: Int? = nil, superseded: Bool? = nil, source: String, ref: String
  ) {
    self.hits = hits
    self.left = left
    self.error = error
    self.unsynced = unsynced
    self.model = model
    self.reranked = reranked
    self.superseded = superseded
    self.source = source
    self.ref = ref
  }
}

public struct BoxStatus: Codable, Equatable, Sendable {
  public var items: Int
  public var pieces: Int
  public var vectors: Int?
  public var model: String?
  public var left: Int
  public var indexing: Bool
  public var error: String?
  public var synced: Bool
}

public enum BoxError: Error, Equatable, Sendable {
  /// No service is listening and there is no binary to start one
  case unavailable
  /// The binary was started and nothing listened within 15 s
  case didNotStart(String)
  /// The service took longer than the request's time to answer
  case timedOut
  /// The service closed the connection before answering
  case closed
  /// The service's own error answer
  case service(String)
  case io(String)
}

/// How a rerank's error starts when the embedding server has no reranking model
public let boxNoReranker = "No reranking model on the embedding server"

/// What Related by Meaning asks of the index: BoxService, or a fake in tests
public protocol MeaningIndex: Sendable {
  /// The whole set of items of a source at a ref; answers at once (how many it accepted), indexing goes on in the service
  func sync(source: String, ref: String, embedder: BoxEmbedder, items: [BoxItem]) async throws -> Int
  func search(_ q: BoxQuery) async throws -> BoxResult
  /// search, then its best text hits read again by the embedding server's reranker, in the fused order
  func rerank(_ q: BoxQuery) async throws -> BoxResult
  func status(source: String, ref: String) async throws -> BoxStatus
}

public struct BoxService: MeaningIndex {
  /// How long a service the client started has to listen
  static let startWait: Duration = .seconds(15)
  /// The first pause between tries to reach a starting service (doubles up to 200 ms)
  static let firstTry: Duration = .milliseconds(10)

  /// The box binary that `serve` starts the service; nil: only a service already running is used
  public var bin: URL?
  /// Its data folder (socket, token)
  public var home: URL
  /// The longest a request waits for its answer
  public var timeout: Duration

  public init(bin: URL?, home: URL = BoxService.defaultHome, timeout: Duration = .seconds(10)) {
    self.bin = bin
    self.home = home
    self.timeout = timeout
  }

  /// BOX_HOME, else ~/Library/Application Support/codeboard-box (box's paths.rs)
  public static var defaultHome: URL {
    if let h = ProcessInfo.processInfo.environment["BOX_HOME"], !h.isEmpty { return URL(filePath: h) }
    return URL.applicationSupportDirectory.appending(path: "codeboard-box")
  }

  public func sync(source: String, ref: String, embedder: BoxEmbedder, items: [BoxItem]) async throws -> Int {
    struct Body: Encodable {
      var source: String
      var ref: String
      var embedder: BoxEmbedder
      var items: [BoxItem]
    }
    struct Accepted: Decodable { var accepted: Int }
    let a: Accepted = try await ask(
      "sync", Body(source: source, ref: ref, embedder: embedder, items: items))
    return a.accepted
  }

  public func search(_ q: BoxQuery) async throws -> BoxResult { try await ask("search", q) }

  public func rerank(_ q: BoxQuery) async throws -> BoxResult { try await ask("rerank", q) }

  public func status(source: String, ref: String) async throws -> BoxStatus {
    try await ask("status", ["source": source, "ref": ref])
  }

  private func ask<B: Encodable & Sendable, R: Decodable>(_ op: String, _ body: B) async throws -> R {
    let data = try await withCheckedThrowingContinuation { (k: CheckedContinuation<Data, Error>) in
      DispatchQueue.global().async { k.resume(with: Result { try request(op, body) }) }
    }
    return try JSONDecoder().decode(Answer<R>.self, from: data).value()
  }

  /// Blocking: one request on a connection of its own; the answer's line
  private func request(_ op: String, _ body: some Encodable) throws -> Data {
    let fd = try open()
    defer { close(fd) }
    var tv = timeval(
      tv_sec: Int(timeout.components.seconds), tv_usec: Int32(timeout.components.attoseconds / 1_000_000_000_000))
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    var buffer = Data()
    let token: String
    do {
      token = try String(contentsOf: home.appending(path: "token"), encoding: .utf8)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    } catch { throw BoxError.io("cannot read box's token") }
    try send(fd, Request(id: 1, op: "hello", body: ["token": token]))
    let hello = try JSONDecoder().decode(Answer<Hello>.self, from: line(fd, &buffer))
    _ = try hello.value()
    try send(fd, Request(id: 2, op: op, body: body))
    return try line(fd, &buffer)
  }

  /// A connected socket: the running service's, or one started now
  private func open() throws -> Int32 {
    let socket = home.appending(path: "box.sock").path
    if let fd = try dial(socket) { return fd }
    guard let bin else { throw BoxError.unavailable }
    start(bin)
    let until = ContinuousClock.now + Self.startWait
    var pause = Self.firstTry
    while true {
      if let fd = try dial(socket) { return fd }
      if ContinuousClock.now > until { throw BoxError.didNotStart("nothing listens at \(socket)") }
      Thread.sleep(forTimeInterval: Double(pause.components.attoseconds) / 1e18)
      pause = min(.milliseconds(200), pause * 2)
    }
  }

  /// nil: nothing listens there (no socket, or refused)
  private func dial(_ path: String) throws -> Int32? {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { throw BoxError.io("socket path too long") }
    withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: bytes) }
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw BoxError.io("socket: \(String(cString: strerror(errno)))") }
    let ok = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    if ok == 0 { return fd }
    let e = errno
    close(fd)
    if [ENOENT, ECONNREFUSED].contains(e) { return nil }
    throw BoxError.io("connect: \(String(cString: strerror(e)))")
  }

  /// `<bin> serve` in a session of its own (Node's detached), stdio on /dev/null, BOX_HOME set to this home
  private func start(_ bin: URL) {
    var attr = posix_spawnattr_t(nil as OpaquePointer?)
    posix_spawnattr_init(&attr)
    defer { posix_spawnattr_destroy(&attr) }
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID))
    var files = posix_spawn_file_actions_t(nil as OpaquePointer?)
    posix_spawn_file_actions_init(&files)
    defer { posix_spawn_file_actions_destroy(&files) }
    for (fd, mode) in [(Int32(0), O_RDONLY), (1, O_WRONLY), (2, O_WRONLY)] {
      posix_spawn_file_actions_addopen(&files, fd, "/dev/null", mode, 0)
    }
    var env = ProcessInfo.processInfo.environment
    env["BOX_HOME"] = home.path
    let args = [bin.path, "serve"]
    let envs = env.map { "\($0)=\($1)" }
    var pid: pid_t = 0
    let r = withCStrings(args) { argv in
      withCStrings(envs) { envp in posix_spawn(&pid, bin.path, &files, &attr, argv, envp) }
    }
    // a binary that cannot start shows as a service that never listens (index.ts)
    guard r == 0 else { return }
    // reaped when it exits, so it does not stay a zombie while the app runs
    let child = pid
    Thread.detachNewThread { waitpid(child, nil, 0) }
  }

  private func send(_ fd: Int32, _ r: some Encodable) throws {
    var data = try JSONEncoder().encode(r)
    data.append(0x0A)
    try data.withUnsafeBytes { p in
      var at = 0
      while at < p.count {
        let n = write(fd, p.baseAddress! + at, p.count - at)
        if n < 0 { throw errno == EAGAIN ? BoxError.timedOut : BoxError.closed }
        at += n
      }
    }
  }

  /// The next line the service writes
  private func line(_ fd: Int32, _ buffer: inout Data) throws -> Data {
    var chunk = [UInt8](repeating: 0, count: 65536)
    while true {
      if let nl = buffer.firstIndex(of: 0x0A) {
        let l = buffer[buffer.startIndex..<nl]
        buffer = Data(buffer[(nl + 1)...])
        return Data(l)
      }
      let n = read(fd, &chunk, chunk.count)
      if n < 0 { throw errno == EAGAIN ? BoxError.timedOut : BoxError.io(String(cString: strerror(errno))) }
      if n == 0 { throw BoxError.closed }
      buffer.append(contentsOf: chunk[0..<n])
    }
  }
}

private struct Request<B: Encodable>: Encodable {
  var id: Int
  var op: String
  var body: B

  enum Keys: String, CodingKey { case id, op }

  func encode(to encoder: Encoder) throws {
    try body.encode(to: encoder)
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(id, forKey: .id)
    try c.encode(op, forKey: .op)
  }
}

private struct Hello: Decodable {
  var pid: Int
}

private struct Answer<R: Decodable>: Decodable {
  var result: R?
  var error: String?

  func value() throws -> R {
    if let error { throw BoxError.service(error) }
    guard let result else { throw BoxError.io("an answer with neither result nor error") }
    return result
  }
}

/// A NULL-terminated array of C strings, for posix_spawn
private func withCStrings<T>(_ strings: [String], _ body: ([UnsafeMutablePointer<CChar>?]) -> T) -> T {
  let p = strings.map { strdup($0) } + [nil]
  defer { for s in p { free(s) } }
  return body(p)
}
