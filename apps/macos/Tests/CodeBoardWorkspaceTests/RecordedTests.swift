import CodeBoardAnalysis
import Foundation
import Testing

@testable import CodeBoardWorkspace

// What git.ts, source.ts and versions.ts give where no host test checks them, recorded by running the TypeScript on
// the same folders: the workspace's repository with two branches in worktrees (one of them deleted), a repository in
// it and one beside it, installed packages, the standard library, typeshed's stubs, a file in no repository, a
// workspace folder that is no repository and a GitHub Code folder.

private let a1 = ["def a():", "    x = 1", "    y = 2", "    return x + y", ""]
private let a2 = ["def a():", "    x = 10", "    y = 20", "    return x + y", ""]
private let relu = ["def relu(x):", "    y = max(x, 0)", "    return y", ""]
private let loose = ["def loose():", "    return 1", ""]
private let ghSha = "0123456789abcdef0123456789abcdef01234567"

private struct Scenario {
  let b: String
  var w: String { b + "/ws" }
  var site: String { b + "/env/lib/python3.12/site-packages" }
  var gh: String { b + "/gh" }
  let sources: Sources

  init() throws {
    b = tempDir()
    let w = b + "/ws"
    try write(w + "/pkg/a.py", a1.joined(separator: "\n"))
    try write(w + "/notes.txt", "one\n")
    try write(w + "/.gitignore", "build/\n")
    try write(w + "/build/gen.py", "def gen():\n    return 0\n")
    try gitInit(w)
    try sh(w, "add", "-A")
    try sh(w, "commit", "-qm", "base")
    try write(w + "/pkg/a.py", a2.joined(separator: "\n"))
    try sh(w, "commit", "-qam", "two")
    try write(w + "/notes.txt", "one\ntwo\n")
    try sh(w, "commit", "-qam", "three")
    try sh(w, "worktree", "add", "-q", "-b", "side", b + "/wt")
    try write(b + "/wt/notes.txt", "side\n")
    try sh(b + "/wt", "commit", "-qam", "on side")
    try sh(w, "worktree", "add", "-q", "-b", "gone", b + "/gone")
    remove(b + "/gone")
    for (dir, file, msg) in [(w + "/sub", "s.py", "sub base"), (b + "/other", "o.py", "other base")] {
      try write(dir + "/" + file, "def \(file.prefix(1))():\n    pass\n")
      try gitInit(dir)
      try sh(dir, "add", "-A")
      try sh(dir, "commit", "-qm", msg)
    }
    let site = b + "/env/lib/python3.12/site-packages"
    try write(site + "/torch/nn.py", relu.joined(separator: "\n"))
    try FileManager.default.createDirectory(atPath: site + "/torch-2.5.1.dist-info", withIntermediateDirectories: true)
    try write(site + "/yaml/__init__.py", "def load():\n    pass\n")
    try write(site + "/PyYAML-6.0.dist-info/top_level.txt", "_yaml\nyaml\n")
    try write(site + "/six.py", "def six():\n    pass\n")
    try FileManager.default.createDirectory(atPath: site + "/six-1.16.0.dist-info", withIntermediateDirectories: true)
    try write(site + "/nothing/n.py", "x = 1\n")
    try write(b + "/env/lib/python3.12/os.py", "def getcwd():\n    pass\n")
    try write(b + "/stubs/typeshed-fallback/stdlib/builtins.pyi", "class int: ...\n")
    try write(b + "/loose/x.py", loose.joined(separator: "\n"))
    try write(b + "/plain/p.py", "def p():\n    pass\n")
    try write(b + "/gh/own/name/\(ghSha)/src/f.py", "def f():\n    pass\n")
    try write(b + "/gh/own/name/\(ghSha)/.codeboard-ref", "main\n")
    sources = makeSources(RootsWorkspace(roots: [w, b + "/plain"]), githubDir: b + "/gh")
  }

  /// The commit with this message
  func sha(_ msg: String, in dir: String? = nil) throws -> String {
    for l in try sh(dir ?? w, "log", "--all", "--format=%H %s").components(separatedBy: "\n") {
      let parts = l.split(separator: " ", maxSplits: 1)
      if parts.count == 2 && parts[1] == msg { return String(parts[0]) }
    }
    throw GitFailed(description: "no commit \(msg)")
  }

  func seg(
    _ id: String = "s", src: SegmentSource = .repo(repo: ""), path: String = "pkg/a.py", start: Int = 2, end: Int = 3,
    text: [String]? = nil, version: SegmentVersion? = nil, hidden: [ClosedRange<Int>] = []
  ) throws -> CodeSegment {
    CodeSegment(
      id: id, src: src, path: path, lang: "python", start: start, end: end, text: text ?? Array(a1[1...2]),
      version: try version ?? .git(commit: sha("base")), hidden: hidden)
  }
}

@Suite struct RecordedGitTests {
  @Test func listsTheWorktreesWithoutTheOneWhoseFolderIsGone() async throws {
    let s = try Scenario()
    defer { remove(s.b) }
    #expect(
      try await s.sources.git.worktrees(s.w) == [
        Worktree(dir: s.w, head: s.sha("three"), branch: "main"),
        Worktree(dir: s.b + "/wt", head: s.sha("on side"), branch: "side"),
      ])
    #expect(try await s.sources.git.branches(s.w) == ["side", "gone", "main"])
  }

  @Test func logsTheCommitsOfLinesOrElseOfTheFile() async throws {
    let s = try Scenario()
    defer { remove(s.b) }
    let git = s.sources.git
    func entry(_ msg: String) throws -> LogEntry {
      let c = try s.sha(msg)
      return LogEntry(commit: c, msg: msg, date: try sh(s.w, "log", "-1", "--format=%as", c))
    }
    let (two, base) = (try entry("two"), try entry("base"))
    #expect(try await git.logLines(s.w, "pkg/a.py", start: 2, end: 3) == [two, base])
    #expect(try await git.logLines(s.w, "pkg/a.py", start: 1, end: 1) == [base])
    #expect(try await git.logLines(s.w, "pkg/a.py", start: 40, end: 50) == [two, base])
    #expect(try await git.logLines(s.w, "nope.py", start: 1, end: 2) == [])
    #expect(try await git.logLines(s.w, "pkg/a.py", start: 2, end: 3, rev: "HEAD", n: 1) == [two])
    #expect(try await git.commitInfo(s.w, "HEAD") == entry("three"))
    #expect(try await git.commitInfo(s.w, "nope") == nil)
  }

  @Test func resolvesRefsReadsHeadAndTheUpstream() async throws {
    let s = try Scenario()
    defer { remove(s.b) }
    let git = s.sources.git
    let three = try s.sha("three")
    #expect(try await git.resolveRef(s.w, "main") == three)
    #expect(try await git.resolveRef(s.w, "side~1") == three)
    #expect(try await git.resolveRef(s.w, "a b") == nil)
    #expect(try await git.resolveRef(s.w, "nope") == nil)
    #expect(try await git.headOf(s.w) == three)
    #expect(try await git.headOf(s.b + "/plain") == nil)
    #expect(try await git.upstreamRef(s.w) == "main")
  }

  @Test func readsTheGitHubRepositoryOfTheOrigin() async throws {
    let s = try Scenario()
    defer { remove(s.b) }
    let other = s.b + "/other"
    for (url, repo) in [
      ("git@github.com:own/repo.git", GitHubRepo(owner: "own", name: "repo")),
      ("https://github.com/own/repo/", GitHubRepo(owner: "own", name: "repo")),
      ("https://github.com/own/repo.js", GitHubRepo(owner: "own", name: "repo.js")),
      ("https://gitlab.com/a/b", nil),
    ] {
      _ = try? sh(other, "remote", "remove", "origin")
      try sh(other, "remote", "add", "origin", url)
      #expect(try await s.sources.git.githubRemote(other) == repo)
    }
    #expect(try await s.sources.git.githubRemote(s.w) == nil)
  }
}

@Suite struct RecordedSourceTests {
  @Test func placesFilesInTheirSources() async throws {
    let s = try Scenario()
    defer { remove(s.b) }
    let b = s.b
    let gh = "\(b)/gh/own/name/\(ghSha)"
    let expected: [(String, FileLoc)] = [
      ("ws/pkg/a.py", FileLoc(src: .repo(repo: ""), path: "pkg/a.py", root: s.w, abs: "\(b)/ws/pkg/a.py")),
      ("ws/sub/s.py", FileLoc(src: .repo(repo: "sub"), path: "s.py", root: "\(b)/ws/sub", abs: "\(b)/ws/sub/s.py")),
      (
        "other/o.py",
        FileLoc(src: .external(root: "\(b)/other"), path: "o.py", root: "\(b)/other", abs: "\(b)/other/o.py")
      ),
      (
        "env/lib/python3.12/site-packages/torch/nn.py",
        FileLoc(src: .external(root: s.site), path: "torch/nn.py", root: s.site, abs: s.site + "/torch/nn.py")
      ),
      ("plain/p.py", FileLoc(src: .repo(repo: "../plain"), path: "p.py", root: "\(b)/plain", abs: "\(b)/plain/p.py")),
      (
        "loose/x.py",
        FileLoc(src: .external(root: "\(b)/loose"), path: "x.py", root: "\(b)/loose", abs: "\(b)/loose/x.py")
      ),
      (
        "gh/own/name/\(ghSha)/src/f.py",
        FileLoc(
          src: .github(owner: "own", name: "name", ref: "main"), path: "src/f.py", root: gh, abs: gh + "/src/f.py",
          fixed: .git(commit: ghSha))
      ),
      ("ws/build/gen.py", FileLoc(src: .repo(repo: ""), path: "build/gen.py", root: s.w, abs: "\(b)/ws/build/gen.py")),
    ]
    for (f, loc) in expected { #expect(try await s.sources.locOfFile(b + "/" + f) == loc) }
  }

  @Test func keysLabelsAndRootsSources() throws {
    let s = try Scenario()
    defer { remove(s.b) }
    let sources = s.sources
    let v = SegmentVersion.git(commit: "abc")
    let cases: [(SegmentSource, String, String, String?)] = [
      (.repo(repo: ""), "repo:", "ws", s.w),
      (.repo(repo: "sub"), "repo:sub", "sub", s.w + "/sub"),
      (.external(root: "/x"), "ext:/x", "/x", "/x"),
      (.github(owner: "o", name: "n", ref: "r"), "gh:o/n", "o/n", s.gh + "/o/n/abc"),
      (.free, "free", "Free code", nil),
    ]
    for (src, key, label, root) in cases {
      #expect(srcKey(src) == key)
      #expect(sources.srcLabel(src) == label)
      #expect(sources.rootOf(src, v) == root)
    }
    #expect(sources.rootOf(.github(owner: "o", name: "n", ref: "r"), .hash("h")) == nil)
    sources.mapRepo("repo:sub", "/elsewhere")
    #expect(sources.rootOf(.repo(repo: "sub"), v) == "/elsewhere")
    #expect(sources.repoMap == ["repo:sub": "/elsewhere"])
  }

  @Test func readsInstalledVersions() async throws {
    let s = try Scenario()
    defer { remove(s.b) }
    let pkg = SegmentVersion.pkg(name: "", version: "")
    let text = "bde64e3e6a7512a2"
    let cases: [(String, SegmentVersion, String)] = [
      ("env/lib/python3.12/site-packages/torch/nn.py", .pkg(name: "torch", version: "2.5.1"), "torch 2.5.1"),
      ("env/lib/python3.12/site-packages/yaml/__init__.py", .pkg(name: "PyYAML", version: "6.0"), "PyYAML 6.0"),
      ("env/lib/python3.12/site-packages/six.py", .pkg(name: "six", version: "1.16.0"), "six 1.16.0"),
      ("env/lib/python3.12/site-packages/nothing/n.py", .hash(text), "Installed"),
      ("env/lib/python3.12/os.py", .pkg(name: "Python", version: "3.12 stdlib"), "Python 3.12 stdlib"),
      ("stubs/typeshed-fallback/stdlib/builtins.pyi", .pkg(name: "typeshed", version: "stdlib"), "typeshed stdlib"),
      ("loose/x.py", .hash(text), "Installed"),
    ]
    for (f, version, label) in cases {
      #expect(await s.sources.currentVersion(s.b + "/" + f, pkg, "text") == version)
      #expect(await s.sources.currentVersionLabel(s.b + "/" + f, pkg) == label)
    }
    #expect(await s.sources.currentVersion(s.b + "/loose/x.py", .hash(""), "text") == .hash(text))
    #expect(await s.sources.currentVersionLabel(s.b + "/loose/x.py", .hash("")) == "Current file")
  }

  @Test func pinsNewSegments() async throws {
    let s = try Scenario()
    defer { remove(s.b) }
    let three = try s.sha("three")
    func pin(_ f: String, _ start: Int, _ end: Int, _ text: [String]) async throws -> Pin {
      try await s.sources.versionFor(
        s.sources.locOfFile(s.b + "/" + f), start: start, end: end, text: text, symbol: nil, lang: "python")
    }
    #expect(try await pin("ws/pkg/a.py", 2, 3, Array(a2[1...2])) == Pin(version: .git(commit: three), start: 2, end: 3))
    try write(s.w + "/pkg/a.py", (["# top"] + a2).joined(separator: "\n"))
    // Moved in the working file: HEAD's line numbers
    #expect(try await pin("ws/pkg/a.py", 3, 4, Array(a2[1...2])) == Pin(version: .git(commit: three), start: 2, end: 3))
    try write(
      s.w + "/pkg/a.py",
      ["# top", "def a():", "    x = 11", "    y = 20", "    return x + y", ""].joined(separator: "\n"))
    #expect(
      try await pin("ws/pkg/a.py", 3, 4, ["    x = 11", "    y = 20"])
        == Pin(version: .git(commit: three, uncommitted: true), start: 3, end: 4))
    try write(s.w + "/new.py", "def n():\n    pass\n")
    #expect(
      try await pin("ws/new.py", 1, 2, ["def n():", "    pass"])
        == Pin(version: .git(commit: three, uncommitted: true), start: 1, end: 2))
    #expect(
      try await pin("ws/build/gen.py", 1, 2, ["def gen():", "    return 0"])
        == Pin(version: .hash("a22d8deba8e549c1"), start: 1, end: 2))
    #expect(
      try await pin("env/lib/python3.12/site-packages/torch/nn.py", 1, 2, Array(relu[0...1]))
        == Pin(version: .pkg(name: "torch", version: "2.5.1"), start: 1, end: 2))
    #expect(
      try await pin("loose/x.py", 1, 2, Array(loose[0...1]))
        == Pin(version: .hash("e6a5d716f9cc5012"), start: 1, end: 2))
    #expect(
      try await pin("gh/own/name/\(ghSha)/src/f.py", 1, 2, ["def f():", "    pass"])
        == Pin(version: .git(commit: ghSha), start: 1, end: 2))
    #expect(try await pin("loose/none.py", 1, 2, ["x"]) == Pin(version: .none, start: 1, end: 2))
  }

  @Test func readsTheFileAtASegmentsVersionAndFindsItsLinesInTheWorkingFile() async throws {
    let s = try Scenario()
    defer { remove(s.b) }
    let sources = s.sources
    let work = ["# top", "def a():", "    x = 11", "    y = 20", "    return x + y", ""]
    try write(s.w + "/pkg/a.py", work.joined(separator: "\n"))
    let base = try s.sha("base")
    #expect(try await sources.versionText(s.seg()) == a1.joined(separator: "\n"))
    #expect(
      try await sources.versionText(
        s.seg(start: 3, end: 4, text: ["    x = 11", "    y = 20"], version: .git(commit: base, uncommitted: true)))
        == work.joined(separator: "\n"))
    #expect(try await sources.versionText(s.seg(text: ["nope", "no"])) == nil)
    #expect(
      try await sources.versionText(
        s.seg(
          src: .github(owner: "own", name: "name", ref: "main"), path: "src/f.py", start: 1, end: 2, text: ["x"],
          version: .git(commit: ghSha))) == "def f():\n    pass\n")
    #expect(try await sources.versionText(s.seg(src: .free)) == nil)

    let abs = s.w + "/pkg/a.py"
    func place(_ start: Int, _ end: Int, _ exact: Bool) -> WorkingPlace {
      WorkingPlace(abs: abs, start: start, end: end, lines: work, exact: exact)
    }
    #expect(await sources.workingPlace(try s.seg(start: 2, end: 2, text: ["def a():"])) == place(2, 2, true))
    #expect(
      await sources.workingPlace(try s.seg(start: 2, end: 4, text: ["def a():", "    x = 1", "    y = 20"]))
        == place(2, 4, false))
    #expect(await sources.workingPlace(try s.seg(text: ["gone", "too"])) == place(2, 3, false))
    #expect(await sources.workingPlace(try s.seg(start: 1, end: 1, text: ["zzz"])) == place(1, 1, false))
    #expect(await sources.workingPlace(try s.seg(src: .free)) == nil)
    #expect(await sources.workingPlace(try s.seg(path: "none.py")) == nil)
  }
}

@Suite struct RecordedStaleTests {
  @Test func checksEveryKindOfSourceAgainstItsNewerVersion() async throws {
    let s = try Scenario()
    defer { remove(s.b) }
    try write(s.w + "/pkg/a.py", a2.joined(separator: "\n"))
    try write(s.b + "/loose/x.py", (["# moved"] + loose).joined(separator: "\n"))
    try write(
      s.site + "/torch/nn.py", ["def relu(x):", "    y = max(x, 1)", "    return y", ""].joined(separator: "\n"))
    let (two, three) = (try s.sha("two"), try s.sha("three"))
    let segs = [
      try s.seg("older commit, changed since", start: 1, end: 4, text: Array(a1[0...3])),
      try s.seg("older commit, only hidden lines changed", start: 1, end: 4, text: Array(a1[0...3]), hidden: [2...3]),
      try s.seg("older commit, same since", start: 1, end: 1, text: ["def a():"]),
      try s.seg("at HEAD", text: Array(a2[1...2]), version: .git(commit: three)),
      try s.seg("uncommitted, same", text: Array(a2[1...2]), version: .git(commit: two, uncommitted: true)),
      try s.seg("uncommitted, gone", text: ["x", "y"], version: .git(commit: two, uncommitted: true)),
      try s.seg(
        "loose moved", src: .external(root: s.b + "/loose"), path: "x.py", start: 1, end: 2, text: Array(loose[0...1]),
        version: .hash("h")),
      try s.seg(
        "package changed", src: .external(root: s.site), path: "torch/nn.py", start: 1, end: 3,
        text: Array(relu[0...2]),
        version: .pkg(name: "torch", version: "2.4.0")),
      try s.seg("repo not there", src: .repo(repo: "nope")),
      try s.seg("file not there", src: .external(root: s.b + "/loose"), path: "none.py", version: .hash("h")),
      try s.seg("github", src: .github(owner: "own", name: "name", ref: "main")),
      try s.seg("free", src: .free),
      try s.seg("upstream", start: 1, end: 1, text: ["def a():"]),
    ]
    let three7 = String(three.prefix(7))
    #expect(
      try await s.sources.staleFor(segs, upstream: ["upstream"]) == [
        "older commit, changed since": .changed(hiddenOnly: false, head: three7),
        "older commit, only hidden lines changed": .changed(hiddenOnly: true, head: three7),
        "older commit, same since": .ok,
        "at HEAD": .ok,
        "uncommitted, same": .ok,
        "uncommitted, gone": .lost,
        "loose moved": .moved(start: 2, end: 3, version: .hash("3e16afde6dd997de")),
        "package changed": .changed(hiddenOnly: false, head: "torch 2.5.1"),
        "repo not there": .missing,
        "file not there": .missing,
        "github": .ok,
        "free": .ok,
        "upstream": .ok,
      ])

    try write(s.w + "/pkg/a.py", (["# up"] + a2).joined(separator: "\n"))
    try sh(s.w, "commit", "-qam", "four")
    try sh(s.w, "update-ref", "refs/remotes/origin/main", "HEAD")
    try sh(s.w, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    try sh(s.w, "reset", "-q", "--hard", "HEAD~1")
    await s.sources.git.forgetRepos()
    let four = try s.sha("four")
    #expect(
      try await s.sources.staleFor(
        [segs[12], try s.seg("upstream at it", start: 2, end: 2, text: ["def a():"], version: .git(commit: four))],
        upstream: ["upstream", "upstream at it"]) == [
          "upstream": .moved(start: 2, end: 2, version: .git(commit: four)),
          "upstream at it": .ok,
        ])
  }
}

@Test func joinsResolvesAndSplitsPathsAsNodeDoes() {
  let cases: [(String, [String], String)] = [
    ("normalize", [""], "."),
    ("normalize", ["."], "."),
    ("normalize", ["./"], "./"),
    ("normalize", ["a//b/../c/"], "a/c/"),
    ("normalize", ["/a/./b/.."], "/a"),
    ("normalize", ["/.."], "/"),
    ("normalize", ["../a/../../b"], "../../b"),
    ("normalize", ["a/.."], "."),
    ("normalize", ["/a/b/"], "/a/b/"),
    ("normalize", ["//a"], "/a"),
    ("join", ["/a", "b", "../c"], "/a/c"),
    ("join", ["", "x"], "x"),
    ("join", ["/a/", "/b/"], "/a/b/"),
    ("join", ["a", ""], "a"),
    ("join", ["/r", "x/"], "/r/x/"),
    ("resolve", ["/a/b", "../c"], "/a/c"),
    ("resolve", ["/a", "/b/c/"], "/b/c"),
    ("resolve", ["/a/b", "c/./d/.."], "/a/b/c"),
    ("resolve", ["/", ".."], "/"),
    ("relative", ["/a/b", "/a/b"], ""),
    ("relative", ["/a/b", "/a/b/c/d"], "c/d"),
    ("relative", ["/a/b/c", "/a/x"], "../../x"),
    ("relative", ["/a", "/"], ".."),
    ("relative", ["/a/b/", "/a/b/c"], "c"),
    ("dirname", ["/a/b"], "/a"),
    ("dirname", ["/a"], "/"),
    ("dirname", ["a"], "."),
    ("dirname", ["/a/b/"], "/a"),
    ("dirname", ["/"], "/"),
    ("dirname", ["a//b"], "a/"),
    ("dirname", ["//a"], "//"),
    ("basename", ["/a/b"], "b"),
    ("basename", ["/a/b/"], "b"),
    ("basename", ["/"], ""),
    ("basename", ["a"], "a"),
    ("basename", [""], ""),
  ]
  for (f, a, r) in cases {
    let got =
      switch f {
      case "normalize": NodePath.normalize(a[0])
      case "join": a.count == 2 ? NodePath.join(a[0], a[1]) : NodePath.join(a[0], a[1], a[2])
      case "resolve": NodePath.resolve(a[0], a[1])
      case "relative": NodePath.relative(a[0], a[1])
      case "dirname": NodePath.dirname(a[0])
      default: NodePath.basename(a[0])
      }
    #expect(got == r, "\(f)(\(a))")
  }
}
