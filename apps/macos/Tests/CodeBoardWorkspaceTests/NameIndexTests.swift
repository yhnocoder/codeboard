import CodeBoardAnalysis
import CodeBoardWorkspace
import Foundation
import Testing

// packages/host/test/nameindex-updates.test.ts: on a copy of nano-vllm of each test's own, since tests make a file in it
@Suite(.timeLimit(.minutes(1)))
struct NameIndexTests {
  private static let probe = "nanovllm/zz_index_probe.py"

  private func key(_ es: [IndexEntry]) -> [String] { es.map { "\($0.abs):\($0.qual):\($0.defLine)" } }

  /// Every name's definitions, by analysing every code file the workspace lists
  private func fullScan(_ host: Host) async -> [String: [String]] {
    var full: [String: [String]] = [:]
    for f in await host.ws.findFiles(.code, max: .max) {
      for s in analyze("python", await host.ws.readText(f) ?? "").symbols {
        full[s.name, default: []].append("\(f):\(s.qual):\(s.defLine)")
      }
    }
    return full
  }

  private func withHost(clock: any Clock<Duration> = ContinuousClock(), _ body: (Host) async throws -> Void)
    async throws
  {
    try await withNano { root in
      let host = Host(root, clock: clock)
      try await body(host)
      await host.index.dispose()
    }
  }

  @Test func findsANameBeforeTheIndexIsBuiltTheSameDefinitionsAsAFullScan() async throws {
    try await withHost { host in
      let full = await fullScan(host)
      #expect(key(await host.index.lookupName("Scheduler")) == full["Scheduler"])
    }
  }

  @Test func matchesTheFullScanForEveryNameReadingTheWorkspaceFileListOnce() async throws {
    try await withHost { host in
      let full = await fullScan(host)
      #expect(full.count > 50)
      var differ: [String] = []
      for (name, want) in full.sorted(by: { $0.key < $1.key }) where key(await host.index.lookupName(name)) != want {
        differ.append(name)
      }
      #expect(differ == [])
      // the index's listing and the test's own
      #expect(host.ws.finds == 2)
    }
  }

  @Test func hasEveryEntryOnceInAllNames() async throws {
    try await withHost { host in
      let full = await fullScan(host)
      await host.index.ready()
      let all = await host.index.allNames()
      #expect(all.reduce(0) { $0 + $1.count } == full.values.reduce(0) { $0 + $1.count })
      #expect(Set(all.map { $0[0].name }).count == all.count)
    }
  }

  @Test func followsCreatedChangedSavedAndDeletedFilesWithoutARescan() async throws {
    try await withHost { host in
      let probe = host.ws.root + "/" + Self.probe
      let index = host.index
      #expect(await index.lookupName("Scheduler").count == 1)
      try write(probe, "def probe_one():\n    pass\n")
      await index.changed(probe)
      #expect(await index.lookupName("probe_one").count == 1)
      try write(probe, "def probe_two():\n    pass\n")
      await index.changed(probe)
      #expect(await index.lookupName("probe_one").count == 0)
      #expect(await index.lookupName("probe_two").count == 1)
      host.ws.setUnsaved(probe, "def probe_three():\n    pass\n")
      await index.changed(probe)
      #expect(await index.lookupName("probe_three").count == 1)
      host.ws.setUnsaved(probe, nil)
      try FileManager.default.removeItem(atPath: probe)
      await index.removed(probe)
      #expect(await index.lookupName("probe_two").count == 0)
      #expect(await index.lookupName("probe_three").count == 0)
      #expect(host.ws.finds == 1)
    }
  }

  // the TypeScript counts timer ticks; here other calls on the index are what must get in between files
  @Test func letsOtherWorkOnTheIndexRunWhileBuildingInTheBackground() async throws {
    try await withHost { host in
      await host.index.start()
      var partial = 0
      while true {
        let files = await host.index.indexedFiles()
        let done = files.filter { $0.entries != nil }.count
        if done == files.count { break }
        if done > 0 { partial += 1 }
      }
      #expect(partial > 3)
    }
  }

  @Test func startsNoNewFileWhileAClickResolvesAndFinishesAfterIt() async throws {
    try await withHost { host in
      await host.index.start()
      while await host.done() == 0 { await Task.yield() }
      let llm = host.ws.root + "/nanovllm/llm.py"
      let during = await host.sched.run(.click) {
        let first = await host.done()
        // as many file reads as the build would need to analyse several files
        for _ in 0..<30 {
          _ = FileManager.default.contents(atPath: llm)
          await Task.yield()
        }
        return [first, await host.done()]
      }
      // the file being analysed when the click came
      #expect(during[1] - during[0] <= 1)
      #expect(during[1] < (await host.index.indexedFiles()).count)
      await host.index.ready()
      #expect(await host.index.indexedFiles().allSatisfy { $0.entries != nil })
    }
  }

  @Test
  func pausesForAClickThatNeverFinishesOnlyHoldMaxThenBuildsToTheEndAndTheNextClickPausesItAgainUntilItIsDone()
    async throws
  {
    let clock = TestClock()
    try await withHost(clock: clock) { host in
      let index = host.index
      await index.start()
      while await host.done() == 0 { await Task.yield() }
      // a language server that never answers
      let unstick = Gate()
      let stuck = Task { await host.sched.run(.click) { await unstick.wait() } }
      await unstick.untilArrived()
      await clock.untilSleeping(1)
      let first = await host.done()
      await turns(30)
      #expect(await host.done() - first <= 1)
      clock.advance(by: holdMax - .milliseconds(1))
      await turns(30)
      #expect(await host.done() - first <= 1)
      clock.advance(by: .milliseconds(1))
      await index.ready()
      #expect(await index.indexedFiles().allSatisfy { $0.entries != nil })

      // a new click pauses it again while the first is still stuck
      let second = Gate()
      let next = Task { await host.sched.run(.click) { await second.wait() } }
      await second.untilArrived()
      let probe = host.ws.root + "/" + Self.probe
      try write(probe, "def probe_paused():\n    pass\n")
      await index.changed(probe)
      await turns(30)
      let entries = { await index.indexedFiles().first { $0.abs == probe }?.entries }
      #expect(await entries() == nil)
      // and only until that click is done, though the first one is still stuck
      second.open()
      await next.value
      while await entries() == nil { await Task.yield() }
      #expect(await entries()?.map(\.name) == ["probe_paused"])
      unstick.open()
      await stuck.value
    }
  }
}
