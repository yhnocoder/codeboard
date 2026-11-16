/// The rest redraws: started a few at a time, their results swapped onto the screen within a budget per frame. A new
/// gesture cancels everything; results of a cancelled generation are dropped when they come in. Notes (and SVG
/// pictures) have a lane of their own, so a board of long Notes never holds the threads code cards need.
struct RedrawQueue<Payload> {
  struct Ready {
    var job: RestPlan.Job
    var payload: Payload
    var pixels: Int
  }

  static var concurrency: Int { 4 }
  /// Notes in flight: laid out and drawn, or read from the disk cache
  static var noteConcurrency: Int { 4 }
  static var pixelsPerFrame: Int { 8_000_000 }
  static var itemsPerFrame: Int { 4 }
  static var hiddenPerFrame: Int { 16 }

  private(set) var generation = 0
  private(set) var pending: [RestPlan.Job] = []
  /// Started and not finished, cancelled ones included: they still hold a thread (or a place in the web view's line)
  private(set) var running = 0
  private var notesRunning = 0
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
    var i = 0
    while i < pending.count, running - notesRunning < Self.concurrency || notesRunning < Self.noteConcurrency {
      let note = pending[i].note
      guard note ? notesRunning < Self.noteConcurrency : running - notesRunning < Self.concurrency else {
        i += 1
        continue
      }
      running += 1
      if note { notesRunning += 1 }
      out.append((pending.remove(at: i), generation))
    }
    return out
  }

  /// A job is done (or failed: payload nil). Returns whether its result was kept
  @discardableResult
  mutating func finish(_ job: RestPlan.Job, generation g: Int, payload: Payload?, pixels: Int) -> Bool {
    running -= 1
    if job.note { notesRunning -= 1 }
    guard g == generation, let payload else { return false }
    ready.append(Ready(job: job, payload: payload, pixels: pixels))
    return true
  }

  /// What to swap in this frame, in the order they finished: those in view (`shown`) up to the pixel and item budgets
  /// (the first always goes, so a bitmap larger than the pixel budget still gets on screen), and up to
  /// `hiddenPerFrame` out of view besides, which cost the frame next to nothing: nothing composites them until the
  /// camera reaches them (a board's Notes beyond the view otherwise came in one or two a frame, their pictures big)
  mutating func takeSwaps(shown: (Ready) -> Bool = { _ in true }) -> [Ready] {
    var px = 0
    var inView = 0
    var hidden = 0
    var take: [Ready] = []
    var keep: [Ready] = []
    for r in ready {
      if shown(r) {
        if inView < Self.itemsPerFrame, inView == 0 || px + r.pixels <= Self.pixelsPerFrame {
          px += r.pixels
          inView += 1
          take.append(r)
        } else {
          keep.append(r)
        }
      } else if hidden < Self.hiddenPerFrame {
        hidden += 1
        take.append(r)
      } else {
        keep.append(r)
      }
    }
    ready = keep
    return take
  }
}
