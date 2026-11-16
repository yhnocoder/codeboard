import CodeBoardModel
import Foundation

// Translations of arXiv papers by tongtu (the owner's translation tool, a command of its own): one job at a time, each
// `tongtu run <paper> --workdir <this machine's folder>/<paper>`, followed by polling `tongtu status <paper> --workdir
// … --json`; once it is done its Chinese PDF and block list (`out/<paper>.zh.pdf`, `out/<paper>.zh.anchors.json`) are
// copied into the entry's folder and named by a new Version. Nothing of tongtu's is ever in the vault. Jobs not finished
// are kept in a file beside the work folders, so after a relaunch they are offered again (never restarted alone).

/// Where a job is: tongtu's stage now, and how far through it when that is known
public struct TranslationProgress: Equatable, Sendable {
  public var stage: String
  public var fraction: Double?

  public init(stage: String, fraction: Double? = nil) {
    self.stage = stage
    self.fraction = fraction
  }
}

/// A translation of one version of a paper's entry
public struct TranslationJob: Codable, Hashable, Sendable {
  /// The vault's folder
  public var vault: String
  public var entry: EntryID
  /// The version translated, which the translation is `of`
  public var version: VersionID
  /// What tongtu is given: the arXiv id with that version's number (`1706.03762v7`), so the source is that version's
  public var paper: String
  /// The new version's label (`v7 中文`)
  public var label: String

  public init(vault: String, entry: EntryID, version: VersionID, paper: String, label: String) {
    self.vault = vault
    self.entry = entry
    self.version = version
    self.paper = paper
    self.label = label
  }

  /// Its work folder's name, which tongtu names its output after (`/` of an old-style id as `_`, as tongtu does)
  public var name: String { paper.replacing("/", with: "_") }
}

public enum TranslationState: Equatable, Sendable {
  case waiting
  case running(TranslationProgress)
  /// Why, in tongtu's words; Retry runs it again from where tongtu stopped
  case failed(String)
}

/// Finding tongtu and reading what it says
public enum Tongtu {
  /// Where it is looked for after the setting and PATH
  public static let usualPlaces = ["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]

  /// The executable: `setting` when it is set (nil when that is not an executable), else the first `tongtu` in PATH or
  /// the usual places
  public static func find(setting: String?, path: String? = ProcessInfo.processInfo.environment["PATH"]) -> URL? {
    let fm = FileManager.default
    if let s = setting?.trimmingCharacters(in: .whitespaces), !s.isEmpty {
      let p = (s as NSString).expandingTildeInPath
      return fm.isExecutableFile(atPath: p) ? URL(filePath: p) : nil
    }
    let dirs = (path ?? "").split(separator: ":").map(String.init) + usualPlaces
    for d in dirs {
      let p = ((d as NSString).expandingTildeInPath as NSString).appendingPathComponent("tongtu")
      if fm.isExecutableFile(atPath: p) { return URL(filePath: p) }
    }
    return nil
  }

  /// From `tongtu status --json`: the first stage not done (the one running while a run goes on; translate with its
  /// chunks done out of all), and, for a run that stopped, the first stage that failed and its message
  public static func read(status data: Data) -> (progress: TranslationProgress, failure: String?)? {
    struct Stage: Decodable {
      var name: String
      var status: String
      var message: String?
    }
    struct Chunks: Decodable {
      var total: Int
      var done: Int
    }
    struct Status: Decodable {
      var stages: [Stage]
      var chunks: Chunks?
      enum CodingKeys: String, CodingKey {
        case stages
        case chunks = "translate_chunks"
      }
    }
    guard let s = try? JSONDecoder().decode(Status.self, from: data) else { return nil }
    guard let at = s.stages.first(where: { $0.status != "ok" }) else {
      return (TranslationProgress(stage: "done", fraction: 1), nil)
    }
    var fraction: Double?
    if at.name == "translate", let c = s.chunks, c.total > 0 { fraction = Double(c.done) / Double(c.total) }
    let failure =
      at.status == "absent"
      ? nil : [at.name, at.status, at.message ?? ""].filter { !$0.isEmpty }.joined(separator: ": ")
    return (TranslationProgress(stage: at.name, fraction: fraction), failure)
  }

  /// What a child is given: this process's environment with the usual places and TeX's in PATH (an app started from
  /// the Dock has a short one)
  static var environment: [String: String] {
    var env = ProcessInfo.processInfo.environment
    let more = usualPlaces.map { ($0 as NSString).expandingTildeInPath } + ["/Library/TeX/texbin"]
    env["PATH"] = ((env["PATH"].map { [$0] } ?? ["/usr/bin:/bin"]) + more).joined(separator: ":")
    return env
  }

  /// `exe` run with `arguments` until it ends, off the main thread: its exit status and what it printed (stderr too
  /// when `errors`)
  static func exec(_ exe: URL, _ arguments: [String], errors: Bool = false) async -> (Int32, String) {
    await withCheckedContinuation { c in
      DispatchQueue.global().async {
        let p = Process()
        p.executableURL = exe
        p.arguments = arguments
        p.environment = environment
        let out = Pipe()
        p.standardOutput = out
        p.standardError = errors ? out : FileHandle.nullDevice
        do { try p.run() } catch {
          c.resume(returning: (-1, error.localizedDescription))
          return
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        c.resume(returning: (p.terminationStatus, String(decoding: data, as: UTF8.self)))
      }
    }
  }
}

/// The queue of translations on this machine: one runs at a time (a translation is heavy), the rest wait. A job
/// outlives the tab that asked for it. Every change is posted as `changed`
@MainActor public final class Translations {
  public static let changed = Notification.Name("CodeBoardTranslationsChanged")

  /// This machine's folder for them (never in the vault): a work folder per paper, their logs and the jobs file
  public let folder: URL
  /// Where tongtu is now (the setting, PATH, the usual places); nil: not found
  public var tongtu: () -> URL?
  /// How often a running job's status is read
  let poll: Duration
  public private(set) var jobs: [TranslationJob] = []
  private var states: [TranslationJob: TranslationState] = [:]
  private var worker: Task<Void, Never>?
  private var process: Process?
  private var cancelling: TranslationJob?
  /// `tongtu doctor` passed once
  private var checked = false

  private var jobsFile: URL { folder.appending(path: "jobs.json") }

  private struct Saved: Codable {
    var job: TranslationJob
    var failed: String?
  }

  /// Jobs left from the last run are offered again as failed: started then, they are not started alone now
  public init(folder: URL, tongtu: @escaping () -> URL?, poll: Duration = .seconds(5)) {
    self.folder = folder
    self.tongtu = tongtu
    self.poll = poll
    let saved = (try? Data(contentsOf: jobsFile)).flatMap { try? JSONDecoder().decode([Saved].self, from: $0) } ?? []
    for s in saved where states[s.job] == nil {
      jobs.append(s.job)
      states[s.job] = .failed(s.failed ?? "CodeBoard quit before this translation was done. Retry to go on.")
    }
  }

  /// tongtu's absence in a few words, nil when it is there
  public var missing: String? {
    tongtu() == nil ? "tongtu was not found: set where it is in Settings, or install it in ~/.local/bin." : nil
  }

  /// The job translating this version of this entry, and where it is
  public func job(_ entry: EntryID, _ version: VersionID) -> (TranslationJob, TranslationState)? {
    jobs.first { $0.entry == entry && $0.version == version }.flatMap { j in states[j].map { (j, $0) } }
  }

  public func state(of job: TranslationJob) -> TranslationState? { states[job] }

  /// A translation asked for: queued, or run again when it had failed; one already waiting or running stays as it is
  public func add(_ job: TranslationJob) {
    switch states[job] {
    case nil: jobs.append(job)
    case .failed?: break
    default: return
    }
    states[job] = .waiting
    changed()
    pump()
  }

  public func retry(_ job: TranslationJob) { add(job) }

  /// The job gone: the process this queue started for it is terminated (only that one), a waiting or failed one just
  /// leaves
  public func cancel(_ job: TranslationJob) {
    guard let s = states[job] else { return }
    if case .running = s, let process {
      cancelling = job
      process.terminate()
      return
    }
    drop(job)
  }

  /// Until no job is running (tests)
  public func settled() async {
    while let w = worker { await w.value }
  }

  private func pump() {
    guard worker == nil else { return }
    worker = Task { [weak self] in
      while let self, let next = self.jobs.first(where: { self.states[$0] == .waiting }) {
        await self.run(next)
      }
      self?.worker = nil
    }
  }

  private func run(_ job: TranslationJob) async {
    guard let exe = tongtu() else { return fail(job, missing ?? "") }
    set(job, .running(TranslationProgress(stage: "doctor")))
    if !checked {
      let (code, out) = await Tongtu.exec(exe, ["doctor"], errors: true)
      guard code == 0 else { return fail(job, "tongtu doctor: " + out.trimmingCharacters(in: .whitespacesAndNewlines)) }
      checked = true
    }
    let dir = folder.appending(path: job.name, directoryHint: .isDirectory)
    let log = folder.appending(path: "\(job.name).log")
    let p = Process()
    p.executableURL = exe
    p.arguments = ["run", job.paper, "--workdir", dir.path]
    p.environment = Tongtu.environment
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      FileManager.default.createFile(atPath: log.path, contents: nil)
      let out = try FileHandle(forWritingTo: log)
      p.standardOutput = out
      p.standardError = out
      try p.run()
    } catch {
      return fail(job, "tongtu could not be started: \(error.localizedDescription)")
    }
    process = p
    set(job, .running(TranslationProgress(stage: "fetch")))
    var failure: String?
    while p.isRunning {
      try? await Task.sleep(for: poll)
      let (code, out) = await Tongtu.exec(exe, ["status", job.paper, "--workdir", dir.path, "--json"])
      if code == 0, let read = Tongtu.read(status: Data(out.utf8)) {
        failure = read.failure
        if p.isRunning { set(job, .running(read.progress)) }
      }
    }
    process = nil
    if cancelling == job {
      cancelling = nil
      return drop(job)
    }
    guard p.terminationStatus == 0 else {
      let (_, out) = await Tongtu.exec(exe, ["status", job.paper, "--workdir", dir.path, "--json"])
      let said = Tongtu.read(status: Data(out.utf8))?.failure ?? failure
      let tail = (try? String(contentsOf: log, encoding: .utf8))?.split(separator: "\n").suffix(3).joined(
        separator: "\n")
      return fail(job, said ?? tail ?? "tongtu stopped (exit status \(p.terminationStatus)).")
    }
    do {
      try finish(job, dir)
      drop(job)
    } catch {
      fail(job, "\(error)")
    }
  }

  struct Unfinished: Error, CustomStringConvertible {
    var description: String
  }

  /// Its PDF and block list copied into the entry's folder, each under a plain name nothing there has, and the new
  /// Version appended to the entry as it is now
  private func finish(_ job: TranslationJob, _ dir: URL) throws {
    let vault = Vault(root: URL(filePath: job.vault, directoryHint: .isDirectory))
    guard let found = EntryIndex(vault, try vault.tree())[job.entry] else {
      throw Unfinished(description: "The paper's entry is no longer in the vault.")
    }
    let out = dir.appending(path: "out")
    let pdfName = "\(job.name).zh.pdf"
    guard let pdf = try? Data(contentsOf: out.appending(path: pdfName)) else {
      throw Unfinished(description: "tongtu finished without out/\(pdfName).")
    }
    let anchorsName = "\(job.name).zh.anchors.json"
    let anchors = try? Data(contentsOf: out.appending(path: anchorsName))
    var e = try vault.entry(at: found.path)
    guard e.versions.contains(where: { $0.id == job.version }) else {
      throw Unfinished(description: "The version it translates is no longer in the entry.")
    }
    let file = try vault.addEntryFile(pdf, named: pdfName, to: found.path)
    let blocks = try anchors.map { try vault.addEntryFile($0, named: anchorsName, to: found.path) }
    e.versions.append(
      Version(
        id: VersionID(rawValue: Board.newID("v")), label: job.label, added: Entry.now, language: "zh", of: job.version,
        content: .pdf(file: file, blocks: blocks)))
    try vault.write(e, at: found.path)
  }

  private func set(_ job: TranslationJob, _ s: TranslationState) {
    guard states[job] != nil, states[job] != s else { return }
    states[job] = s
    changed()
  }

  private func fail(_ job: TranslationJob, _ why: String) { set(job, .failed(why)) }

  private func drop(_ job: TranslationJob) {
    jobs.removeAll { $0 == job }
    states[job] = nil
    changed()
  }

  private func changed() {
    let saved = jobs.map { j -> Saved in
      if case .failed(let why) = states[j] { return Saved(job: j, failed: why) }
      return Saved(job: j)
    }
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try? JSONEncoder().encode(saved).write(to: jobsFile, options: .atomic)
    NotificationCenter.default.post(name: Self.changed, object: self)
  }
}
