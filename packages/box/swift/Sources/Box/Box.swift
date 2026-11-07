// box's index in this process, over its C ABI: the requests of PROTOCOL.md as JSON, without the socket. One process per data
// folder may have it open. Requests run off the caller's thread (a search embeds its query).
import CBox
import Foundation

public struct BoxError: Error, CustomStringConvertible {
  public let description: String
}

/// An OpenAI-compatible embedding endpoint (the key stays in this process's memory)
public struct Embedder: Codable, Sendable {
  public var base: String
  public var model: String?
  public var key: String?
  public init(base: String, model: String? = nil, key: String? = nil) {
    self.base = base
    self.model = model
    self.key = key
  }
}

public struct Item: Codable, Sendable {
  public var id: String
  public var title: String
  public var text: String
  /// What a search can be narrowed to
  public var groups: [String]?
  public init(id: String, title: String, text: String, groups: [String]? = nil) {
    self.id = id
    self.title = title
    self.text = text
    self.groups = groups
  }
}

public struct Hit: Codable, Sendable {
  public var id: String
  public var score: Double
  /// Which piece matched (by meaning): 0 the whole item, then its paragraphs, then its images
  public var piece: Int?
  /// Where the piece is in the item's text, as UTF-16 offsets
  public var range: [Int]?
  public var picture: String?
}

/// A hit of the keyword group: its BM25 score and where the first query word is (UTF-16 offsets)
public struct KeywordHit: Codable, Sendable {
  public var id: String
  public var score: Double
  public var range: [Int]?
}

public struct KeywordResult: Codable, Sendable {
  public var hits: [KeywordHit]
}

public struct SearchResult: Codable, Sendable {
  public var hits: [Hit]
  public var left: Int?
  public var error: String?
  public var unsynced: Bool?
  public var model: String?
}

public struct Status: Codable, Sendable {
  public var items: Int
  public var pieces: Int
  public var vectors: Int?
  public var model: String?
  public var left: Int
  public var indexing: Bool
  public var error: String?
  public var synced: Bool
}

public final class BoxIndex: @unchecked Sendable {
  private let handle: OpaquePointer

  /// Opens (making it if missing) the index in the data folder; throws when another process has it open
  public init(home: URL) throws {
    var err: UnsafeMutablePointer<CChar>?
    guard let h = box_open(home.path, &err) else {
      let why = err.map { String(cString: $0) } ?? "cannot open"
      box_string_free(err)
      throw BoxError(description: why)
    }
    handle = h
  }

  deinit { box_close(handle) }

  /// One request as JSON (with its "op") → its answer as JSON ({"result": …} or {"error": …}), on this thread
  public func requestJSON(_ json: String) -> String {
    let out = box_request(handle, json)!
    defer { box_string_free(out) }
    return String(cString: out)
  }

  /// One request: op and its fields → the result, decoded; throws with the request's error
  public func request<T: Decodable>(_ op: String, _ fields: [String: Any], as: T.Type = T.self) async throws -> T {
    var body = fields
    body["op"] = op
    let json = String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)
    let answer: String = await withCheckedContinuation { done in
      DispatchQueue.global(qos: .userInitiated).async { done.resume(returning: self.requestJSON(json)) }
    }
    let obj = try JSONSerialization.jsonObject(with: Data(answer.utf8)) as? [String: Any] ?? [:]
    if let e = obj["error"] as? String { throw BoxError(description: e) }
    let result = try JSONSerialization.data(withJSONObject: obj["result"] ?? [:], options: .fragmentsAllowed)
    return try JSONDecoder().decode(T.self, from: result)
  }

  private func encode<T: Encodable>(_ v: T) throws -> Any {
    try JSONSerialization.jsonObject(with: try JSONEncoder().encode(v))
  }

  /// The whole set of a source's items at a ref; answers at once, indexing goes on in the background
  public func sync(source: String, ref: String, embedder: Embedder, items: [Item]) async throws {
    struct Accepted: Decodable { var accepted: Int }
    let fields: [String: Any] = ["source": source, "ref": ref, "embedder": try encode(embedder), "items": try encode(items)]
    _ = try await request("sync", fields, as: Accepted.self)
  }

  /// By meaning: what is indexed now, never waiting for indexing
  public func search(source: String, ref: String, q: String, k: Int = 10, groups: [String]? = nil) async throws
    -> SearchResult
  {
    var fields: [String: Any] = ["source": source, "ref": ref, "q": q, "k": k]
    if let groups { fields["groups"] = groups }
    return try await request("search", fields)
  }

  /// The keyword group (full text): its own list, never mixed with search's; needs no model
  public func searchKeyword(source: String, ref: String, q: String, k: Int = 10, groups: [String]? = nil) async throws
    -> KeywordResult
  {
    var fields: [String: Any] = ["source": source, "ref": ref, "q": q, "k": k]
    if let groups { fields["groups"] = groups }
    return try await request("search_keyword", fields)
  }

  public func status(source: String, ref: String) async throws -> Status {
    try await request("status", ["source": source, "ref": ref])
  }

  public func forget(source: String) async throws {
    struct Empty: Decodable {}
    _ = try await request("forget", ["source": source], as: Empty.self)
  }
}
