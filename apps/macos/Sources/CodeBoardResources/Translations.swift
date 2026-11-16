import CodeBoardModel
import Foundation

// Translations of arXiv papers by tongtu (the owner's translation tool, a command of its own): one job at a time, each
// `tongtu run <paper> --workdir <this machine's folder>/<paper>`, followed by polling `tongtu status <paper> --workdir
// … --json`; once it is done its Chinese PDF, block list and the TeX the list's lines are of (`out/<paper>.zh.pdf`,
// `out/<paper>.zh.anchors.json`, `build/zh.tex`) are copied into the entry's folder and named by a new Version. Nothing of tongtu's is ever in the vault. Jobs not finished
// are kept in a file beside the work folders, so after a relaunch they are offered again (never restarted alone).

/// Where a job is: tongtu's stage now, and how far through it when that is known (translate: its chunks done of all)
public struct TranslationProgress: Equatable, Sendable {
  public struct Chunks: Equatable, Sendable {
    public var done: Int
    public var total: Int
  }

  public var stage: String
  public var fraction: Double?
  public var chunks: Chunks?

  public init(stage: String, fraction: Double? = nil, chunks: Chunks? = nil) {
    self.stage = stage
    self.fraction = fraction
    self.chunks = chunks
  }
}

/// Why a job failed: the stage of tongtu's that failed, when it was one, and what tongtu or CodeBoard said
public struct TranslationFailure: Codable, Equatable, Sendable {
  public var stage: String?
  public var message: String

  public init(stage: String? = nil, _ message: String) {
    self.stage = stage
    self.message = message
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

  /// The translation of `version` of `entry`, an arXiv paper of `vault`: tongtu is given the number of that version
  /// (from its label `v<n>`; without one the newest) so its source is that version's; nil for an entry not from arXiv
  public init?(vault: Vault, entry: Entry, version: Version) {
    guard case .arxiv(let id)? = entry.origin else { return nil }
    self.init(
      vault: vault.root.path, entry: entry.id, version: version.id,
      paper: Arxiv.number(version).map { "\(id)v\($0)" } ?? id,
      label: [version.label, "中文"].compactMap { $0 }.joined(separator: " "))
  }

  /// Its work folder's name, which tongtu names its output after (`/` of an old-style id as `_`, as tongtu does)
  public var name: String { paper.replacing("/", with: "_") }
}

public enum TranslationState: Equatable, Sendable {
  case waiting
  case running(TranslationProgress)
  /// Why, in tongtu's words; Retry runs it again from where tongtu stopped
  case failed(TranslationFailure)
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
  /// chunks done out of all), and, for a run that stopped, the first stage that failed and its message (its status
  /// code when it gives none); whether a run is going on, when the status says (`running`, newer tongtus). Keys not
  /// known here are passed over
  public static func read(status data: Data) -> (
    progress: TranslationProgress, failure: TranslationFailure?, running: Bool?
  )? {
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
      var running: Bool?
      var pid: Int?
      enum CodingKeys: String, CodingKey {
        case stages, running, pid
        case chunks = "translate_chunks"
      }
    }
    guard let s = try? JSONDecoder().decode(Status.self, from: data) else { return nil }
    guard let at = s.stages.first(where: { $0.status != "ok" }) else {
      return (TranslationProgress(stage: "done", fraction: 1), nil, s.running)
    }
    var progress = TranslationProgress(stage: at.name)
    if at.name == "translate", let c = s.chunks, c.total > 0 {
      progress.fraction = Double(c.done) / Double(c.total)
      progress.chunks = .init(done: c.done, total: c.total)
    }
    let said = at.message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let failure = at.status == "absent" ? nil : TranslationFailure(stage: at.name, said.isEmpty ? at.status : said)
    return (progress, failure, s.running)
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
    var failed: TranslationFailure?
  }

  /// Jobs left from the last run are offered again as failed: started then, they are not started alone now; one that
  /// tongtu says is still running (a run this app started before it quit) is shown running and followed until it ends
  public init(folder: URL, tongtu: @escaping () -> URL?, poll: Duration = .seconds(5)) {
    self.folder = folder
    self.tongtu = tongtu
    self.poll = poll
    let saved = (try? Data(contentsOf: jobsFile)).flatMap { try? JSONDecoder().decode([Saved].self, from: $0) } ?? []
    for s in saved where states[s.job] == nil {
      jobs.append(s.job)
      states[s.job] = .failed(
        s.failed ?? TranslationFailure("CodeBoard quit before this translation was done. Retry to go on."))
    }
    if !jobs.isEmpty { Task { [weak self] in await self?.followRunning() } }
  }

  /// The jobs offered again that tongtu says are running: shown running until their run ends, then taken in as one of
  /// this queue's runs is (finish), or failed with tongtu's message
  private func followRunning() async {
    guard let exe = tongtu() else { return }
    for job in jobs {
      guard case .failed(let why)? = states[job] else { continue }
      let dir = folder.appending(path: job.name, directoryHint: .isDirectory)
      var read = await status(exe, job, dir)
      guard read?.running == true else { continue }
      while let r = read, r.running == true {
        set(job, .running(r.progress))
        try? await Task.sleep(for: poll)
        guard states[job] != nil else { break }
        read = await status(exe, job, dir)
      }
      guard states[job] != nil else { continue }
      guard read?.progress.stage == "done" else {
        set(job, .failed(read?.failure ?? why))
        continue
      }
      do {
        try finish(job, dir)
        drop(job)
      } catch {
        fail(job, "\(error)")
      }
    }
  }

  /// What `tongtu status` says of a job's work folder; nil when it says nothing readable
  private func status(_ exe: URL, _ job: TranslationJob, _ dir: URL) async -> (
    progress: TranslationProgress, failure: TranslationFailure?, running: Bool?
  )? {
    Tongtu.read(status: Data(await Tongtu.exec(exe, ["status", job.paper, "--workdir", dir.path, "--json"]).1.utf8))
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
      guard code == 0 else {
        let said = out.trimmingCharacters(in: .whitespacesAndNewlines)
        return fail(job, said.isEmpty ? "tongtu doctor stopped (exit status \(code))." : said, stage: "doctor")
      }
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
    var failure: TranslationFailure?
    while p.isRunning {
      try? await Task.sleep(for: poll)
      if let read = await status(exe, job, dir) {
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
      let said = await status(exe, job, dir)?.failure ?? failure
      let tail = (try? String(contentsOf: log, encoding: .utf8))?.split(separator: "\n").suffix(3).joined(
        separator: "\n")
      if let said { return set(job, .failed(said)) }
      return fail(job, tail ?? "tongtu stopped (exit status \(p.terminationStatus)).")
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

  /// Its PDF, block list and TeX copied into the entry's folder, each under a plain name nothing there has, and the new
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
    // the TeX the block list's line numbers are of: build/zh.tex (the list's `tex`)
    let tex = anchors == nil ? nil : try? Data(contentsOf: dir.appending(path: "build/zh.tex"))
    var e = try vault.entry(at: found.path)
    guard e.versions.contains(where: { $0.id == job.version }) else {
      throw Unfinished(description: "The version it translates is no longer in the entry.")
    }
    let file = try vault.addEntryFile(pdf, named: pdfName, to: found.path)
    let blocks = try anchors.map { try vault.addEntryFile($0, named: anchorsName, to: found.path) }
    let source = try tex.map { try vault.addEntryFile($0, named: "\(job.name).zh.tex", to: found.path) }
    e.versions.append(
      Version(
        id: VersionID(rawValue: Board.newID("v")), label: job.label, added: Entry.now, language: "zh", of: job.version,
        content: .pdf(file: file, blocks: blocks, source: source)))
    try vault.write(e, at: found.path)
  }

  private func set(_ job: TranslationJob, _ s: TranslationState) {
    guard states[job] != nil, states[job] != s else { return }
    states[job] = s
    changed()
  }

  private func fail(_ job: TranslationJob, _ why: String, stage: String? = nil) {
    set(job, .failed(TranslationFailure(stage: stage, why)))
  }

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
