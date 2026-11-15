import Foundation
import Testing

@testable import CodeBoardModel

// One vault, however its folder is spelled, keeps its cameras in one file: a camera written by one spelling is read
// back by any other
@Test func aVaultReachedByAnotherSpellingOfItsFolderHasTheSameCameras() throws {
  let fm = FileManager.default
  let base = fm.temporaryDirectory.appending(path: "cams-\(UUID().uuidString)")
  defer { try? fm.removeItem(at: base) }
  let real = base.appending(path: "vault")
  try fm.createDirectory(at: real, withIntermediateDirectories: true)
  let link = base.appending(path: "link")
  try fm.createSymbolicLink(at: link, withDestinationURL: real)
  let store = CameraStore(folder: base.appending(path: "Cameras"))
  try store.keep([BoardID(rawValue: "b"): BoardCamera(x: 51, y: 152, zoom: 1.7)], for: Vault(root: real))
  // the temporary folder is under /var, a symlink to /private/var
  let path = real.path
  let other = path.hasPrefix("/private/") ? String(path.dropFirst("/private".count)) : "/private" + path
  let spellings = [
    URL(filePath: other, directoryHint: .isDirectory), URL(filePath: path + "/"), link,
    base.appending(path: "vault/../vault"),
  ]
  for s in spellings {
    #expect(store.cameras(for: Vault(root: s))[BoardID(rawValue: "b")]?.x == 51, "\(s.path)")
  }
}
