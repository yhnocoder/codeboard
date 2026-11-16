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

// When each board was last opened is kept per board, beside the cameras and outside the vault
@Test func whenEachBoardWasLastOpenedIsKeptPerBoardOutsideTheVault() throws {
  let fm = FileManager.default
  let base = fm.temporaryDirectory.appending(path: "opened-\(UUID().uuidString)")
  defer { try? fm.removeItem(at: base) }
  let root = base.appending(path: "vault")
  try fm.createDirectory(at: root, withIntermediateDirectories: true)
  let vault = Vault(root: root)
  let store = CameraStore(folder: base.appending(path: "Cameras"))
  let a = BoardID(rawValue: "a")
  let b = BoardID(rawValue: "b")
  #expect(store.opened(for: vault).isEmpty)
  try store.keepOpened(a, at: Date(timeIntervalSince1970: 100), for: vault)
  try store.keepOpened(b, at: Date(timeIntervalSince1970: 200), for: vault)
  try store.keepOpened(a, at: Date(timeIntervalSince1970: 300), for: vault)
  #expect(store.opened(for: vault) == [a: Date(timeIntervalSince1970: 300), b: Date(timeIntervalSince1970: 200)])
  #expect(store.cameras(for: vault).isEmpty, "not among the cameras")
  #expect(try fm.contentsOfDirectory(atPath: root.path).isEmpty, "nothing in the vault")
  #expect(store.openedFile(for: vault).deletingLastPathComponent().lastPathComponent == "Opened")
}
