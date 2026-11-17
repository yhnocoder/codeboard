import CodeBoardWorkspace
import Foundation
import Testing

// The key a repository's code annotations are kept under (FORMAT.md, Code annotations)
@Suite struct AnnotationsKeyTests {
  @Test func aRepositoryWithoutARemoteIsKeyedByItsFirstCommitNotItsPath() async throws {
    let r = try tempRepo(["a.py": "x = 1\n"])
    defer { remove(r) }
    let first = try sh(r, "rev-parse", "HEAD")
    try write(r + "/a.py", "x = 2\n")
    try sh(r, "commit", "-qam", "next")
    let key = await GitCache().annotationsKey(r, remote: nil)
    #expect(key == "root:\(first)")
    #expect(key?.contains(r) == false && key?.contains("/") == false)
    #expect(await GitCache().annotationsKey(r, remote: "git@github.com:Owner/Name.git") == "github.com/owner/name")
  }

  @Test func aShallowCloneWithoutARemoteHasNoKey() async throws {
    let r = try tempRepo(["a.py": "x = 1\n"])
    try write(r + "/a.py", "x = 2\n")
    try sh(r, "commit", "-qam", "next")
    let clone = tempDir()
    defer { remove(r, clone) }
    try sh(clone, "clone", "-q", "--depth", "1", "file://" + r, "c")
    #expect(await GitCache().rootKey(clone + "/c") == nil)
  }
}
