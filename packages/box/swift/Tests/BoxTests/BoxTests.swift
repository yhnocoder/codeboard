import Foundation
import XCTest

@testable import Box

final class BoxTests: XCTestCase {
  func testOpenAskAndOneProcessPerFolder() async throws {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("box-swift-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: home) }
    let index = try BoxIndex(home: home)
    XCTAssertThrowsError(try BoxIndex(home: home))
    let status = try await index.status(source: "src", ref: "main")
    XCTAssertEqual(status.items, 0)
    XCTAssertFalse(status.synced)
    let r = try await index.search(source: "src", ref: "main", q: "kv cache")
    XCTAssertEqual(r.unsynced, true)
    do {
      struct Any_: Decodable {}
      _ = try await index.request("nope", [:], as: Any_.self)
      XCTFail("an unknown op is an error")
    } catch let e as BoxError {
      XCTAssertTrue(e.description.contains("unknown op"))
    }
    try await index.forget(source: "src")
  }

  /// The keyword group needs no model: with no embedding server at all, a sync makes its items findable by their words
  func testKeywordSearchWithoutAModel() async throws {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("box-swift-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: home) }
    let index = try BoxIndex(home: home)
    let items = [
      Item(id: "a", title: "BlockManager", text: "BlockManager.deallocate frees the kv cache blocks."),
      Item(id: "b", title: "计算受限", text: "prefill 是计算受限。"),
    ]
    try await index.sync(source: "src", ref: "main", embedder: Embedder(base: "http://127.0.0.1:9/v1"), items: items)
    var hits: [KeywordHit] = []
    for _ in 0..<400 where hits.isEmpty {
      hits = try await index.searchKeyword(source: "src", ref: "main", q: "deallocate").hits
      if hits.isEmpty { try await Task.sleep(nanoseconds: 5_000_000) }  // a poll: the sync's job adds the documents
    }
    XCTAssertEqual(hits.map(\.id), ["a"])
    XCTAssertEqual(hits.first?.range, [13, 23])
    let zh = try await index.searchKeyword(source: "src", ref: "main", q: "计算受限")
    XCTAssertEqual(zh.hits.map(\.id), ["b"])
  }
}
