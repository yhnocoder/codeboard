import CodeBoardModel
import CodeBoardResources
import Foundation

/// A board shown while recording: as it was when it first came on screen and as it was at the end. Boards are values,
/// so keeping them costs nothing while recording; they are encoded when the report is put together
struct BoardShot: Sendable {
  var id: BoardID
  var title: String
  /// Its package, relative to the vault
  var path: String
  var start: Board
  var end: Board?
  /// When it first came on screen (Diag.now())
  var shownAt: Double
}

/// What a report takes from the vault and the code: read off the main thread when recording stops
struct ReportSources: Sendable {
  var vault: Vault?
  var boards: [BoardShot]
  /// Every board's title, by id (sub-boards never entered are listed by title and id)
  var titles: [BoardID: String]
  var entries: EntryIndex
  var resources: [VaultResource]
  /// The reading pane's tabs opened or gone to while recording, and the one in front at the start: their payloads
  /// with their kind and key
  var reading: [[String: String]]
  var home = NSHomeDirectory()
  /// Where clones of a card's repository are looked for when the card does not say where it was read: none unless
  /// given (the person's own app gives `defaultCodeRoots`; a driver's run and tests never look in a home folder)
  var codeRoots: [URL] = []

  static var defaultCodeRoots: [URL] {
    let home = URL(filePath: NSHomeDirectory(), directoryHint: .isDirectory)
    return ["Projects", "Developer", "Code", "code", "src", "repos", "GitHub", "Documents/GitHub", "work"].map {
      home.appending(path: $0, directoryHint: .isDirectory)
    }
  }
}

/// boards/, code/ and resources/, with what could not be found said in `notes`
struct GatheredContents: Sendable {
  var files: [ReportFile] = []
  var notes: [String] = []
}

enum ReportContents {
  static func gather(_ s: ReportSources) -> GatheredContents {
    var out = GatheredContents()
    boards(s, into: &out)
    code(s, into: &out)
    resources(s, into: &out)
    return out
  }

  // MARK: boards/

  struct BoardListing: Codable {
    var id: String
    var title: String
    var path: String?
    /// Seconds after the recording began that it came on screen; nil: never entered (a sub-board card's board)
    var shownAt: Double?
    var folder: String?
    /// The board at the end was as at its first showing: there is no end.json
    var unchanged: Bool?
  }

  static func folderName(_ b: BoardShot) -> String { reportName("\(b.title) (\(b.id.rawValue))") }

  static func boards(_ s: ReportSources, into out: inout GatheredContents) {
    var listing: [BoardListing] = []
    let shown = Set(s.boards.map(\.id))
    var never: [BoardID] = []
    var shared: Set<CardID> = []
    let t0 = s.boards.map(\.shownAt).min() ?? 0
    for b in s.boards {
      let folder = "boards/\(folderName(b))"
      listing.append(
        BoardListing(
          id: b.id.rawValue, title: b.title, path: b.path, shownAt: ((b.shownAt - t0) * 1000).rounded() / 1000,
          folder: folder, unchanged: b.end == b.start ? true : nil))
      if let d = try? b.start.encoded() { out.files.append(ReportFile("\(folder)/start.json", d)) }
      if let end = b.end, end != b.start, let d = try? end.encoded() {
        out.files.append(ReportFile("\(folder)/end.json", d))
      }
      for board in [b.start, b.end].compactMap({ $0 }) {
        for c in allCards(board) {
          if c.isShared { shared.insert(c.id) }
          if case .own(let content) = c.content, case .board(let sub) = content.body, case .board(let id) = sub.target,
            !shown.contains(id), !never.contains(id)
          {
            never.append(id)
          }
        }
      }
    }
    for id in never {
      listing.append(
        BoardListing(id: id.rawValue, title: s.titles[id] ?? "(not in the vault)", path: nil, shownAt: nil))
    }
    if let d = try? JSONEncoder.report.encode(listing) { out.files.append(ReportFile("boards/index.json", d)) }
    guard let vault = s.vault else { return }
    for id in shared.sorted(by: { $0.rawValue < $1.rawValue }) where safePath(id.rawValue + ".json") != nil {
      let url = vault.sharedFolderURL.appending(path: "\(id.rawValue).json")
      if FileManager.default.fileExists(atPath: url.path) {
        out.files.append(ReportFile("boards/shared/\(id.rawValue).json", copying: url))
      }
    }
  }

  static func allCards(_ b: Board) -> [Card] { b.cards + b.shelf.flatMap(\.cards) }

  // MARK: resources/

  static func resources(_ s: ReportSources, into out: inout GatheredContents) {
    guard let vault = s.vault else { return }
    // the images the boards name: every file of a board's images folder whose name its file holds
    for b in s.boards {
      let text = [b.start, b.end].compactMap { $0 }.compactMap { try? $0.encoded() }.map {
        String(decoding: $0, as: UTF8.self)
      }.joined()
      let folder = vault.url(of: b.path).appending(path: Vault.imagesFolder)
      for name in files(in: folder) where text.contains(name) {
        out.files.append(
          ReportFile("resources/images/\(folderName(b))/\(name)", copying: folder.appending(path: name)))
      }
    }
    let sharedImages = vault.sharedFolderURL.appending(path: Vault.imagesFolder)
    let sharedText = out.files.filter { $0.path.hasPrefix("boards/shared/") }.compactMap { f -> String? in
      guard case .file(let u) = f.source else { return nil }
      return try? String(contentsOf: u, encoding: .utf8)
    }.joined()
    for name in files(in: sharedImages) where sharedText.contains(name) {
      out.files.append(ReportFile("resources/images/shared/\(name)", copying: sharedImages.appending(path: name)))
    }

    // entries the cards were taken from or picture, and what the reading pane opened
    var wanted: [(entry: EntryID, version: VersionID?)] = []
    for b in s.boards {
      for board in [b.start, b.end].compactMap({ $0 }) {
        for c in allCards(board) {
          guard case .own(let content) = c.content else { continue }
          if let a = content.source { wanted.append((a.entry, a.place?.version)) }
          if case .image(let img) = content.body, case .resource(let a) = img.source {
            wanted.append((a.entry, a.place?.version))
          }
        }
      }
    }
    var listed: [String] = []
    for r in s.reading {
      if let e = r["entry"] {
        wanted.append((EntryID(rawValue: e), r["version"].map { VersionID(rawValue: $0) }))
      } else if let f = r["file"], safePath(f) != nil {
        let url = vault.url(of: f)
        if FileManager.default.fileExists(atPath: url.path) {
          out.files.append(ReportFile("resources/files/\(f)", copying: url))
        }
      } else if let id = r["resource"], let res = s.resources.first(where: { $0.id.rawValue == id }) {
        let url = vault.url(of: res.path).appending(path: Vault.resourceFileName)
        out.files.append(ReportFile("resources/lists/\(reportName(res.title))/\(Vault.resourceFileName)", copying: url))
      } else if let u = r["url"] {
        listed.append(u)
      }
    }
    if !listed.isEmpty, let d = try? JSONEncoder.report.encode(listed) {
      out.files.append(ReportFile("resources/web-tabs.json", d))
    }
    var done: Set<String> = []
    for (id, version) in wanted {
      guard let found = s.entries[id] else {
        if done.insert(id.rawValue).inserted { out.notes.append("Entry \(id.rawValue) is not in the vault") }
        continue
      }
      let folder = vault.url(of: found.path)
      let base =
        "resources/entries/\(reportName(found.path.split(separator: "/").last.map(String.init) ?? id.rawValue))"
      if done.insert(id.rawValue).inserted {
        out.files.append(
          ReportFile("\(base)/\(Vault.entryFileName)", copying: folder.appending(path: Vault.entryFileName)))
      }
      let versions = found.entry.versions.filter { version == nil || $0.id == version }
      for v in versions {
        let names: [String]
        switch v.content {
        case .pdf(let file, let blocks, let source): names = [file, blocks, source].compactMap { $0 }
        case .file(let file), .translation(let file): names = [file]
        case .page: names = []
        }
        for n in names where safePath(n) != nil && done.insert("\(id.rawValue)/\(n)").inserted {
          let url = folder.appending(path: n)
          if FileManager.default.fileExists(atPath: url.path) {
            out.files.append(ReportFile("\(base)/\(n)", copying: url))
          }
        }
      }
    }
  }

  static func files(in folder: URL) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []).filter { !$0.hasPrefix(".") }.sorted()
  }

  // MARK: code/

  struct RepoReport: Codable {
    var name: String
    var remote: String?
    var root: String
    var head: String?
    var branch: String?
    var files: [FileReport]
  }

  struct FileReport: Codable {
    var path: String
    /// The commits the cards read it at
    var cardCommits: [String]
    /// The text now (in the working tree) is in current/; at-<commit>/ holds it as a card read it, when that differs
    var current: Bool
    var differsAt: [String]
  }

  static func code(_ s: ReportSources, into out: inout GatheredContents) {
    // repository key (remote, or checkout when there is none) -> path -> commits
    var repos: [String: (remote: String?, checkout: String?, paths: [String: Set<String>])] = [:]
    var plain: Set<String> = []
    var packages: Set<String> = []
    for b in s.boards {
      for board in [b.start, b.end].compactMap({ $0 }) {
        for c in allCards(board) {
          guard case .own(let content) = c.content, case .code(let code) = content.body else { continue }
          for seg in code.segments {
            switch seg.source {
            case .git(let remote, let commit, let path, _, let checkout):
              let key = remote ?? checkout ?? "?"
              var r = repos[key] ?? (remote, checkout, [:])
              r.paths[path, default: []].insert(commit)
              repos[key] = r
            case .file(let path, _): plain.insert(path)
            case .package(let name, let version, let path): packages.insert("\(name) \(version): \(path)")
            case nil: break
            }
          }
        }
      }
    }
    // the code folders are listed only when a card's checkout does not say where its clone is
    var finder: RepoFinder?
    func find(_ remote: String?, _ checkout: String?) -> URL? {
      if let root = RepoFinder.at(checkout: checkout) { return root }
      guard remote != nil, !s.codeRoots.isEmpty else { return nil }
      if finder == nil { finder = RepoFinder(roots: s.codeRoots) }
      return finder?.find(remote: remote, checkout: nil)
    }
    var unresolved: [String] = []
    for key in repos.keys.sorted() {
      let r = repos[key]!
      guard let root = find(r.remote, r.checkout) else {
        // a card from before remotes were kept names only where VS Code read it
        let named = r.remote ?? r.checkout.flatMap { $0.isEmpty ? nil : $0 }
        unresolved.append(named ?? "the repository of " + r.paths.keys.sorted().joined(separator: ", "))
        continue
      }
      let name = reportName(root.lastPathComponent)
      let base = "code/\(name)"
      var report = RepoReport(
        name: root.lastPathComponent, remote: r.remote ?? Git.run(root, ["remote", "get-url", "origin"]),
        root: tildified(root.path, home: s.home), head: Git.run(root, ["rev-parse", "HEAD"]),
        branch: Git.run(root, ["rev-parse", "--abbrev-ref", "HEAD"]), files: [])
      let paths = r.paths.keys.sorted().filter { safePath($0) != nil }
      for bad in r.paths.keys.sorted() where safePath(bad) == nil {
        unresolved.append("\(bad) (outside its repository)")
      }
      if let diff = Git.data(root, ["diff", "HEAD", "--no-color", "--no-ext-diff", "--"] + paths), !diff.isEmpty {
        out.files.append(ReportFile("\(base)/uncommitted.diff", diff))
      }
      for path in paths {
        let commits = r.paths[path]!.sorted()
        let now = try? Data(contentsOf: root.appending(path: path))
        if now != nil { out.files.append(ReportFile("\(base)/current/\(path)", copying: root.appending(path: path))) }
        var differs: [String] = []
        for commit in commits {
          guard let then = Git.data(root, ["show", "\(commit):\(path)"]), then != now else { continue }
          differs.append(commit)
          out.files.append(ReportFile("\(base)/at-\(commit.prefix(12))/\(path)", then))
        }
        report.files.append(FileReport(path: path, cardCommits: commits, current: now != nil, differsAt: differs))
      }
      if let d = try? JSONEncoder.report.encode(report) { out.files.append(ReportFile("\(base)/repo.json", d)) }
    }
    for path in plain.sorted() {
      let url = URL(filePath: path)
      if path.hasPrefix("/"), FileManager.default.fileExists(atPath: path) {
        out.files.append(ReportFile("code/files/\(reportName(tildified(path, home: s.home)))", copying: url))
      } else {
        unresolved.append(path)
      }
    }
    for r in unresolved { out.notes.append("Code not found on this Mac: \(tildified(r, home: s.home))") }
    for p in packages.sorted() { out.notes.append("Code from an installed package, not copied: \(p)") }
  }
}

/// Finds the clone a card's code was read from: its checkout when that is an absolute path, else a git repository with
/// the same remote in the usual code folders (two levels deep)
struct RepoFinder {
  var roots: [URL]
  private var remotes: [(root: URL, remote: String)] = []

  init(roots: [URL]) {
    self.roots = roots
    var found: [(URL, String)] = []
    let fm = FileManager.default
    func scan(_ dir: URL, depth: Int) {
      guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return }
      for n in names where !n.hasPrefix(".") {
        let sub = dir.appending(path: n, directoryHint: .isDirectory)
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: sub.path, isDirectory: &isDir), isDir.boolValue else { continue }
        if fm.fileExists(atPath: sub.appending(path: ".git").path) {
          for r in Self.remotes(of: sub) { found.append((sub, r)) }
        } else if depth > 0 {
          scan(sub, depth: depth - 1)
        }
      }
    }
    for r in roots { scan(r, depth: 1) }
    remotes = found
  }

  /// The remotes a clone has, from its config file (read, not asked of git: there may be many clones). Only the
  /// `[remote …]` sections: a submodule's url names another repository
  static func remotes(of root: URL) -> [String] {
    guard let config = try? String(contentsOf: root.appending(path: ".git/config"), encoding: .utf8) else { return [] }
    var inRemote = false
    return config.split(separator: "\n").compactMap { line in
      let t = line.trimmingCharacters(in: .whitespaces)
      if t.hasPrefix("[") {
        inRemote = t.hasPrefix("[remote ")
        return nil
      }
      guard inRemote, t.hasPrefix("url"), let eq = t.firstIndex(of: "=") else { return nil }
      return t[t.index(after: eq)...].trimmingCharacters(in: .whitespaces)
    }
  }

  /// github.com/owner/name for every way of writing the same remote (https, ssh, scp-like, with or without .git)
  static func normalized(_ remote: String) -> String {
    var s = remote.lowercased()
    for p in ["https://", "http://", "ssh://", "git://", "git+ssh://"] where s.hasPrefix(p) { s.removeFirst(p.count) }
    if let at = s.firstIndex(of: "@"), !s[..<at].contains("/") { s = String(s[s.index(after: at)...]) }
    if let colon = s.firstIndex(of: ":"), !s[..<colon].contains("/") { s.replaceSubrange(colon...colon, with: "/") }
    if s.hasSuffix(".git") { s.removeLast(4) }
    while s.hasSuffix("/") { s.removeLast() }
    return s
  }

  /// The clone a card names by its absolute checkout, when it is there
  static func at(checkout: String?) -> URL? {
    guard let c = checkout, c.hasPrefix("/"), FileManager.default.fileExists(atPath: c + "/.git") else { return nil }
    return URL(filePath: c, directoryHint: .isDirectory)
  }

  func find(remote: String?, checkout: String?) -> URL? {
    if let root = Self.at(checkout: checkout) { return root }
    guard let remote else { return nil }
    let want = Self.normalized(remote)
    return remotes.first { Self.normalized($0.remote) == want }?.root
  }
}

/// A relative path that stays inside the folder it is joined to: no `..`, not absolute, not empty
func safePath(_ p: String) -> String? {
  let parts = p.split(separator: "/", omittingEmptySubsequences: false)
  guard !p.isEmpty, !p.hasPrefix("/"), !parts.contains(where: { $0 == ".." || $0.isEmpty }) else { return nil }
  return p
}

enum Git {
  static func data(_ root: URL, _ args: [String]) -> Data? {
    let p = Process()
    p.executableURL = URL(filePath: "/usr/bin/git")
    p.arguments = ["-C", root.path] + args
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return nil }
    let d = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return p.terminationStatus == 0 ? d : nil
  }

  static func run(_ root: URL, _ args: [String]) -> String? {
    data(root, args).map { String(decoding: $0, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) }
  }
}
