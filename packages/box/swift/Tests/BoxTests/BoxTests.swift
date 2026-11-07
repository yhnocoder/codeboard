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
}
