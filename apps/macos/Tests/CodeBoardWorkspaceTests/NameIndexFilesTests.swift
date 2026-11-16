import CodeBoardAnalysis
import CodeBoardWorkspace
import Foundation
import Testing

// packages/host/test/nameindex.test.ts
@Suite(.timeLimit(.minutes(1)))
struct NameIndexFilesTests {
  private func withFiles(_ body: (String, Host) async throws -> Void) async throws {
    try await withFolder { root in
      try write(root + "/kernel.hh", "namespace k {\nint launch_hh(int n) {\n  return n;\n}\n}\n")
      try write(root + "/impl.inl", "template <typename T>\nT scale_inl(T x) {\n  return x * 2;\n}\n")
      try write(root + "/notes.txt", "int not_code(int n) { return n; }\n")
      let host = Host(root)
      try await body(root, host)
      await host.index.dispose()
    }
  }

  @Test func coverEveryExtensionOfAnAnalysedLanguage() async throws {
    try await withFiles { _, host in
      for e in ["py", "pyi", "cu", "cuh", "cpp", "cc", "cxx", "hpp", "hh", "hxx", "h", "inl", "c", "rs"] {
        #expect(codeExts().contains(e))
      }
      #expect(FileQuery.code.exts.isSuperset(of: ["hh", "inl"]))
      #expect(host.index.isCode("/w/a/kernel.hh") && host.index.isCode("/w/a/impl.inl"))
      #expect(!host.index.isCode("/w/a/notes.txt") && !host.index.isCode("/w/node_modules/x/kernel.hh"))
    }
  }

  @Test func leaveOutInstalledPackagesByTheFoldersUnderTheWorkspaceRootOnly() async throws {
    try await withFiles { root, host in
      #expect(!host.index.isCode(root + "/env/lib/python3.12/site-packages/pkg/core.py"))
      let pkg = root + "/lib/site-packages/pkg"
      let inPkg = Host(pkg)
      #expect(inPkg.index.isCode(pkg + "/core.py"))
    }
  }

  @Test func findDefinitionsInHhAndInlFiles() async throws {
    try await withFiles { _, host in
      let name = { (e: IndexEntry) in (e.abs as NSString).lastPathComponent }
      #expect(await host.index.lookupName("launch_hh").map(name) == ["kernel.hh"])
      #expect(await host.index.lookupName("scale_inl").map(name) == ["impl.inl"])
      #expect(await host.index.lookupName("not_code") == [])
    }
  }
}

// the name index part of packages/host/test/two-hosts.test.ts
@Test(.timeLimit(.minutes(1))) func twoHostsKeepTheirOwnNameIndex() async throws {
  try await withFolder { dir in
    try write(dir + "/a/m.py", "def alpha():\n    return 1\n")
    try write(dir + "/b/m.py", "def beta():\n    return 1\n")
    let shared = AnalysisCache()
    let a = NameIndex(FolderWorkspace(root: dir + "/a"), analysis: shared, sched: Scheduler())
    let b = NameIndex(FolderWorkspace(root: dir + "/b"), analysis: shared, sched: Scheduler())
    #expect(await a.lookupName("alpha").map(\.abs) == [dir + "/a/m.py"])
    #expect(await b.lookupName("alpha") == [])
    #expect(await b.lookupName("beta").map(\.name) == ["beta"])
    await a.dispose()
    #expect(await b.lookupName("beta").map(\.name) == ["beta"])
    await b.dispose()
  }
}
