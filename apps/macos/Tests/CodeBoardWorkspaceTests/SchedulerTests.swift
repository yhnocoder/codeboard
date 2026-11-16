import CodeBoardWorkspace
import Testing

// packages/host/test/sched.test.ts (what the name index uses of the scheduler)
@Suite(.timeLimit(.minutes(1)))
struct SchedulerTests {
  @Test func holdsLowerPrioritiesBackWhileHigherOnesRunAndNotTheOtherWayRound() async {
    let s = Scheduler(clock: TestClock())
    let click = Gate()
    let run = Task { await s.run(.click) { await click.wait() } }
    await click.untilArrived()
    #expect(await !settles { await s.clear(.hover) })
    #expect(await !settles { await s.clear(.index) })
    await s.clear(.click)
    let idx = Gate()
    let indexing = Task { await s.run(.index) { await idx.wait() } }
    await idx.untilArrived()
    // the click, not the index
    #expect(await !settles { await s.clear(.warm) })
    click.open()
    await run.value
    await s.clear(.warm)
    idx.open()
    await indexing.value
  }

  @Test func holdsThemAtMostHoldMaxForWorkThatNeverFinishesAndNewWorkHoldsThemAgain() async {
    let clock = TestClock()
    let s = Scheduler(clock: clock)
    let never = Gate()
    let stuck = Task { await s.run(.click) { await never.wait() } }
    await never.untilArrived()
    await clock.untilSleeping(1)
    let waiting = Task { await s.clear(.index) }
    clock.advance(by: holdMax - .milliseconds(1))
    #expect(await !settles { await waiting.value })
    clock.advance(by: .milliseconds(1))
    await waiting.value
    let next = Gate()
    let run = Task { await s.run(.click) { await next.wait() } }
    await next.untilArrived()
    #expect(await !settles { await s.clear(.index) })
    next.open()
    await run.value
    await s.clear(.index)
    never.open()
    await stuck.value
  }
}
