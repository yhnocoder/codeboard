import Foundation
import Testing

@testable import CodeBoardModel

// Tests never reach the person's own Trash: the system Trash fails in a test process, so a test that forgot to give its
// own trasher fails before anything moves
@Test func aTestProcessIsKnownSoTheSystemTrashRefusesIt() {
  #expect(Vault.underTest)
}
