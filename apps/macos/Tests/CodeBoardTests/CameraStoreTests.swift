import XCTest
@testable import CodeBoard

final class CameraStoreTests: XCTestCase {
  func testRoundTripAndTornFileKeptAside() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cb-cams-\(UUID().uuidString)")
    let file = dir.appendingPathComponent("cams.json")
    let a = CameraStore(file: file)
    a.set("b1", "{\"x\":1,\"y\":2,\"z\":0.5}")
    a.set("b2", "{\"x\":0,\"y\":0,\"z\":1}")
    a.flush()
    let b = CameraStore(file: file)
    XCTAssertEqual(b.get("b1"), "{\"x\":1,\"y\":2,\"z\":0.5}")
    XCTAssertEqual(b.get("b2"), "{\"x\":0,\"y\":0,\"z\":1}")
    // a file cut short: not read, kept as .bad, and a store that has nothing to say writes nothing over it
    try Data("{\"b1\":{\"x\":1".utf8).write(to: file)
    let c = CameraStore(file: file)
    XCTAssertNil(c.get("b1"))
    c.flush()
    XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: file.appendingPathExtension("bad").path))
  }
}
