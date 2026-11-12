import CodeBoardModel
import Foundation
import Testing

@Test func boardIDIsStoredAsABareString() throws {
  let id = BoardID(rawValue: "b1")
  let json = try JSONEncoder().encode([id])
  #expect(String(decoding: json, as: UTF8.self) == #"["b1"]"#)
  #expect(try JSONDecoder().decode([BoardID].self, from: json) == [id])
}
