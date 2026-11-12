/// The rest redraws: started a few at a time, their results swapped onto the screen within a budget per frame. A new
/// gesture cancels everything; results of a cancelled generation are dropped when they come in.
struct RedrawQueue<Payload> {
  struct Ready {
    var job: RestPlan.Job
    var payload: Payload
    var pixels: Int
  }

  static var concurrency: Int { 4 }
  static var pixelsPerFrame: Int { 8_000_000 }
  static var itemsPerFrame: Int { 4 }

  private(set) var generation = 0
  private(set) var pending: [RestPlan.Job] = []
  /// Started and not finished, cancelled ones included: they still hold a thread
  private(set) var running = 0
  private(set) var ready: [Ready] = []

  var isIdle: Bool { pending.isEmpty && running == 0 && ready.isEmpty }

  mutating func replace(with jobs: [RestPlan.Job]) {
    generation += 1
    pending = jobs
    ready = []
  }

  mutating func cancel() { replace(with: []) }

  /// The jobs to start now, each with the generation its result must carry
  mutating func start() -> [(job: RestPlan.Job, generation: Int)] {
    var out: [(job: RestPlan.Job, generation: Int)] = []
    while running < Self.concurrency, !pending.isEmpty {
      running += 1
      out.append((pending.removeFirst(), generation))
    }
    return out
  }

  /// A job is done (or failed: payload nil). Returns whether its result was kept
  @discardableResult
  mutating func finish(_ job: RestPlan.Job, generation g: Int, payload: Payload?, pixels: Int) -> Bool {
    running -= 1
    guard g == generation, let payload else { return false }
    ready.append(Ready(job: job, payload: payload, pixels: pixels))
    return true
  }

  /// What to swap in this frame: in the order they finished, up to the pixel and item budgets (the first always goes, so
  /// a bitmap larger than the pixel budget still gets on screen)
  mutating func takeSwaps() -> [Ready] {
    var px = 0
    var n = 0
    while n < ready.count, n < Self.itemsPerFrame, n == 0 || px + ready[n].pixels <= Self.pixelsPerFrame {
      px += ready[n].pixels
      n += 1
    }
    defer { ready.removeFirst(n) }
    return Array(ready.prefix(n))
  }
}
