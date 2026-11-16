import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardResources

/// A stand-in for tongtu in a folder of its own: `doctor`, `run <paper> --workdir <dir>` and `status <paper> --workdir
/// <dir> --json` answered as the real one answers them (its status JSON, `out/<dir name>.zh.pdf` and `.zh.anchors.json`
/// written at the end), each call written to `calls`. Files beside it change what it does: `doctor-fails`, `fail` (the
/// compile stage fails with a message), `hold` (a run waits in translate, 3 of 4 chunks done, until `<dir>/go` is there)
struct FakeTongtu {
  let folder: URL
  var exe: URL { folder.appending(path: "tongtu") }

  init() throws {
    folder = FileManager.default.temporaryDirectory.appending(path: "tongtu-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try Self.script.write(to: exe, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: exe.path)
  }

  func mark(_ name: String, _ on: Bool = true) {
    let u = folder.appending(path: name)
    if on {
      FileManager.default.createFile(atPath: u.path, contents: nil)
    } else {
      try? FileManager.default.removeItem(at: u)
    }
  }

  var calls: [String] {
    ((try? String(contentsOf: folder.appending(path: "calls"), encoding: .utf8)) ?? "").split(separator: "\n").map {
      String($0.split(separator: " ").first ?? "")
    }
  }

  func remove() { try? FileManager.default.removeItem(at: folder) }

  static let script = #"""
    #!/bin/sh
    here=$(dirname "$0")
    echo "$@" >> "$here/calls"
    paper="$2"; dir="$4"
    stages() {
      printf '{"workdir":"%s","arxiv_id":"%s","stages":[' "$dir" "$paper"
      i=0; sep=""
      for stage in fetch precompile mask survey translate review compile; do
        i=$((i+1)); s=$(echo "$1" | cut -d' ' -f$i); msg=""
        if [ "$s" != ok ] && [ "$s" != absent ]; then msg="$2"; fi
        printf '%s{"name":"%s","status":"%s","outputs_present":false,"message":"%s","warnings":[],"manifest":null}' \
          "$sep" "$stage" "$s" "$msg"
        sep=","
      done
      printf '],"translate_chunks":%s,"pdf":null}\n' "$3"
    }
    case "$1" in
    doctor)
      if [ -f "$here/doctor-fails" ]; then
        echo "  [missing] xelatex       compile engine (latexmk -xelatex)         xelatex not found in PATH"
        echo "environment incomplete: xelatex"; exit 1
      fi
      echo "environment complete."; exit 0 ;;
    status)
      if [ -f "$dir/status.json" ]; then cat "$dir/status.json"
      else stages "absent absent absent absent absent absent absent" "" null; fi ;;
    run)
      mkdir -p "$dir/out"; name=$(basename "$dir")
      stages "ok ok ok ok absent absent absent" "" '{"total":4,"done":3}' > "$dir/status.json"
      if [ -f "$here/hold" ]; then while [ ! -f "$dir/go" ]; do sleep 0.02; done; fi
      if [ -f "$here/fail" ]; then
        stages "ok ok ok ok ok ok compile_failed" "47 pages against a baseline of 31" '{"total":4,"done":4}' \
          > "$dir/status.json"
        exit 1
      fi
      echo "translated $paper" > "$dir/out/$name.zh.pdf"
      echo '{"pdf":"'"$name"'.zh.pdf","tex":"zh.tex","pages":[],"blocks":[]}' > "$dir/out/$name.zh.anchors.json"
      stages "ok ok ok ok ok ok ok" "" '{"total":4,"done":4}' > "$dir/status.json" ;;
    esac
    """#
}

/// A vault with the arXiv paper 1706.03762 at v7 in it, a fake tongtu and a queue on a machine folder of its own
@MainActor struct TranslationRig {
  let vault: Vault
  let path: String
  let entry: Entry
  let tongtu: FakeTongtu
  let machine: URL
  let queue: Translations

  init() throws {
    let v = try tempVault()
    vault = v.vault
    let paper = ArxivPaper(id: "1706.03762", title: "Attention Is All You Need", authors: [], year: 2017, latest: 7)
    (entry, path) = try vault.newEntry(paper, version: 7, pdf: FakeArxiv.pdf(7), in: v.resource.path)
    tongtu = try FakeTongtu()
    machine = FileManager.default.temporaryDirectory.appending(path: "machine-\(UUID().uuidString)")
    let exe = tongtu.exe
    queue = Translations(folder: machine, tongtu: { exe }, poll: .milliseconds(20))
  }

  var job: TranslationJob {
    TranslationJob(
      vault: vault.root.path, entry: entry.id, version: entry.versions[0].id, paper: "1706.03762v7", label: "v7 中文")
  }

  func remove() {
    for u in [vault.root, tongtu.folder, machine] { try? FileManager.default.removeItem(at: u) }
  }

  /// Until `ok` holds, at most a few seconds
  func until(_ what: String, _ ok: () -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(10)
    while !ok() {
      guard ContinuousClock.now < deadline else { throw Unmet(what: what) }
      try await Task.sleep(for: .milliseconds(10))
    }
  }

  struct Unmet: Error {
    var what: String
  }
}

@MainActor @Suite(.serialized) struct TranslationTests {
  @Test func aFinishedTranslationIsCopiedInAndAppendedAsAVersionOfTheOriginal() async throws {
    let r = try TranslationRig()
    defer { r.remove() }
    // a file of the name it would take is there already: it is left as it is
    try Data("mine".utf8).write(to: r.vault.url(of: "\(r.path)/1706.03762v7.zh.pdf"))
    var heard = 0
    let watch = NotificationCenter.default.addObserver(forName: Translations.changed, object: r.queue, queue: nil) {
      _ in MainActor.assumeIsolated { heard += 1 }
    }
    defer { NotificationCenter.default.removeObserver(watch) }
    r.queue.add(r.job)
    #expect(r.queue.job(r.entry.id, r.entry.versions[0].id)?.0 == r.job)
    await r.queue.settled()
    #expect(r.queue.state(of: r.job) == nil)
    #expect(r.queue.jobs.isEmpty && heard >= 3)
    #expect(r.tongtu.calls.first == "doctor" && r.tongtu.calls.contains("run"))
    let e = try r.vault.entry(at: r.path)
    #expect(e.versions.first == r.entry.versions[0])
    let zh = try #require(e.versions.dropFirst().first)
    #expect(zh.label == "v7 中文" && zh.language == "zh" && zh.of == r.entry.versions[0].id)
    #expect(zh.content == .pdf(file: "1706.03762v7.zh-2.pdf", blocks: "1706.03762v7.zh.anchors.json"))
    #expect(try String(contentsOf: r.vault.url(of: "\(r.path)/1706.03762v7.zh.pdf"), encoding: .utf8) == "mine")
    #expect(
      try String(contentsOf: r.vault.url(of: "\(r.path)/1706.03762v7.zh-2.pdf"), encoding: .utf8)
        == "translated 1706.03762v7\n")
    // tongtu's work stays on this machine, out of the vault
    #expect(FileManager.default.fileExists(atPath: r.machine.appending(path: "1706.03762v7/out").path))
    #expect(
      try !FileManager.default.contentsOfDirectory(atPath: r.vault.url(of: r.path).path).contains { $0.hasPrefix(".") })
  }

  @Test func progressIsReadFromStatusAndAFailureKeepsTongtusMessageForRetry() async throws {
    let r = try TranslationRig()
    defer { r.remove() }
    r.tongtu.mark("hold")
    r.tongtu.mark("fail")
    r.queue.add(r.job)
    try await r.until("translating") {
      r.queue.state(of: r.job) == .running(TranslationProgress(stage: "translate", fraction: 0.75))
    }
    FileManager.default.createFile(atPath: r.machine.appending(path: "1706.03762v7/go").path, contents: nil)
    await r.queue.settled()
    #expect(r.queue.state(of: r.job) == .failed("compile: compile_failed: 47 pages against a baseline of 31"))
    #expect(try r.vault.entry(at: r.path) == r.entry, "nothing written")
    // retried: it runs again and goes through
    r.tongtu.mark("fail", false)
    r.queue.retry(r.job)
    await r.queue.settled()
    #expect(r.queue.jobs.isEmpty)
    #expect(try r.vault.entry(at: r.path).versions.count == 2)
    #expect(r.tongtu.calls.filter { $0 == "doctor" }.count == 1, "doctor once it passed")
  }

  @Test func aFailingDoctorIsShownAndNothingRuns() async throws {
    let r = try TranslationRig()
    defer { r.remove() }
    r.tongtu.mark("doctor-fails")
    r.queue.add(r.job)
    await r.queue.settled()
    guard case .failed(let why)? = r.queue.state(of: r.job) else {
      Issue.record("not failed")
      return
    }
    #expect(why.hasPrefix("tongtu doctor:") && why.contains("environment incomplete: xelatex"))
    #expect(r.tongtu.calls == ["doctor"])
    // without tongtu at all
    let none = Translations(folder: r.machine.appending(path: "other"), tongtu: { nil })
    #expect(none.missing != nil)
    none.add(r.job)
    await none.settled()
    #expect(none.state(of: r.job) == .failed(none.missing!))
  }

  @Test func jobsRunOneAtATimeAndCancelEndsOnlyTheProcessItStarted() async throws {
    let r = try TranslationRig()
    defer { r.remove() }
    r.tongtu.mark("hold")
    var second = r.job
    second.paper = "1706.03762v6"
    second.label = "v6 中文"
    r.queue.add(r.job)
    r.queue.add(second)
    try await r.until("first translating") {
      if case .running(let p)? = r.queue.state(of: r.job) { return p.stage == "translate" }
      return false
    }
    #expect(r.queue.state(of: second) == .waiting)
    #expect(r.tongtu.calls.filter { $0 == "run" }.count == 1)
    // the first cancelled: its process ends, the second starts
    r.queue.cancel(r.job)
    try await r.until("second translating") {
      if case .running(let p)? = r.queue.state(of: second) { return p.stage == "translate" }
      return false
    }
    #expect(r.queue.state(of: r.job) == nil && r.queue.jobs == [second])
    FileManager.default.createFile(atPath: r.machine.appending(path: "1706.03762v6/go").path, contents: nil)
    await r.queue.settled()
    let e = try r.vault.entry(at: r.path)
    #expect(e.versions.map(\.label) == ["v7", "v6 中文"], "only the second was added")
    // a waiting one cancelled just leaves
    r.queue.add(r.job)
    r.queue.cancel(r.job)
    await r.queue.settled()
    #expect(r.queue.jobs.isEmpty)
  }

  @Test func aJobRunningWhenTheAppQuitIsOfferedAgainAfterARelaunch() async throws {
    let r = try TranslationRig()
    defer { r.remove() }
    r.tongtu.mark("hold")
    r.queue.add(r.job)
    try await r.until("running") {
      if case .running(let p)? = r.queue.state(of: r.job) { return p.stage == "translate" }
      return false
    }
    // what a relaunch reads
    let after = Translations(folder: r.machine, tongtu: { r.tongtu.exe }, poll: .milliseconds(20))
    #expect(after.jobs == [r.job])
    guard case .failed(let why)? = after.state(of: r.job) else {
      Issue.record("not offered again")
      return
    }
    #expect(why.contains("Retry"))
    #expect(r.tongtu.calls.filter { $0 == "run" }.count == 1, "not started alone")
    r.queue.cancel(r.job)
    await r.queue.settled()
  }

  @Test func tongtuIsTheSettingElsePathElseTheUsualPlaces() throws {
    let t = try FakeTongtu()
    defer { t.remove() }
    #expect(Tongtu.find(setting: t.exe.path, path: "") == t.exe)
    #expect(Tongtu.find(setting: t.folder.appending(path: "nope").path, path: t.folder.path) == nil)
    #expect(Tongtu.find(setting: nil, path: "/nowhere:\(t.folder.path)") == t.exe)
    #expect(Tongtu.find(setting: "  ", path: t.folder.path) == t.exe)
  }
}
