import AppKit
import CodeBoardCanvas
import CodeBoardModel

/// `--open-frames`: what each frame shows while a board opens, then while it is panned and zoomed. The window is put
/// below the desktop picture and never activated (nothing reaches the screen or takes the focus); its frames are ticked
/// here at 60 Hz on a stepped clock. Per frame: the items in view, those showing nothing (`empty`) and the Notes showing
/// only their paper (`paper`). Prints one JSON object per board, numbers only.
@MainActor final class OpenFrames {
  struct Phase: Encodable {
    var frames = 0
    /// Frames with an item in view showing nothing, or a Note only its paper
    var framesWithBlank = 0
    var maxBlank = 0
    /// Items that showed something and then nothing (or only paper) in a later frame
    var emptiedAgain = 0
    var redraws = 0
    var swaps = 0
    var noteSwaps = 0
  }

  struct Result: Encodable {
    var cards = 0
    var view: [Int] = []
    /// From asking to open: the board installed (its items placed), the first frame with anything drawn in view, every
    /// item in view drawn, every Note in view sharp
    var installedMs: Double?
    var firstContentMs: Double?
    var allDrawnMs: Double?
    var notesSharpMs: Double?
    /// "first": the canvas showed nothing before (a launch); "switch": another board was shown
    var mode = ""
    /// The first frame with the board's kept picture over the view
    var pictureMs: Double?
    /// Frames, until every item in view is drawn, with neither the picture nor any item in view drawn
    var blankFrames = 0
    /// Frames before the first one with anything drawn (the whole view blank), and of them those after installing
    var blankFramesBeforeContent = 0
    var blankFramesAfterInstall = 0
    /// Items in view that were blank (nothing, or a Note's paper alone) in a frame after the first with content
    var filledLater = 0
    var filledLaterFrames = 0
    /// Of those: items showing nothing at all, and Notes showing only their paper
    var filledLaterEmpty = 0
    var filledLaterPaper = 0
    var opening = Phase()
    var pan = Phase()
    var zoom = Phase()
  }

  let canvas: CanvasView
  private var timer: Timer?
  private var onFrame: (() -> Void)?

  init(canvas: CanvasView) {
    self.canvas = canvas
    canvas.steppedClock = { CACurrentMediaTime() }
  }

  private func startTicking() {
    timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { _ in
      MainActor.assumeIsolated {
        self.canvas.tick(at: CACurrentMediaTime())
        self.onFrame?()
      }
    }
    RunLoop.main.add(timer!, forMode: .common)
  }

  private func frames(until done: @escaping () -> Bool, limit: Double = 30, each: @escaping () -> Void) async {
    let start = CACurrentMediaTime()
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
      var resumed = false
      onFrame = {
        each()
        if !resumed, done() || CACurrentMediaTime() - start > limit {
          resumed = true
          self.onFrame = nil
          c.resume()
        }
      }
    }
  }

  /// The board shown kept as a picture, and the camera it was taken at, as the app does when it quits
  func leave(pictures: URL) {
    canvas.keepCamera(now: true)
    if let b = canvas.shownVaultBoard {
      let c = canvas.currentCamera
      try? JSONEncoder().encode([c.origin.x, c.origin.y, c.zoom]).write(
        to: pictures.appending(path: "camera-\(b.id.rawValue).json"))
    }
    CanvasView.pictureWrites.sync {}
  }

  func run(_ b: VaultBoard, in vault: Vault, pictures: URL? = nil) async throws -> String {
    var r = Result()
    r.mode = canvas.shownVaultBoard == nil ? "first" : "switch"
    if let pictures {
      if canvas.shownVaultBoard != nil { leave(pictures: pictures) }
      if let d = try? Data(contentsOf: pictures.appending(path: "camera-\(b.id.rawValue).json")),
        let c = try? JSONDecoder().decode([CGFloat].self, from: d), c.count == 3
      {
        canvas.arriving = Camera(origin: CGPoint(x: c[0], y: c[1]), zoom: c[2])
      }
    }
    r.view = [Int(canvas.bounds.width), Int(canvas.bounds.height)]
    if timer == nil { startTicking() }
    let t0 = CACurrentMediaTime()
    func ms() -> Double { ((CACurrentMediaTime() - t0) * 1000).rounded() }
    var shown = Set<Int>()
    var installed = false
    var opening = Phase()
    let base = canvas.ruleBreaks
    func sample(_ p: inout Phase, opening: Bool) {
      let s = canvas.blankInView
      p.frames += 1
      let blank = s.empty.union(s.paper)
      if !blank.isEmpty { p.framesWithBlank += 1 }
      p.maxBlank = max(p.maxBlank, blank.count)
      p.emptiedAgain += blank.intersection(shown).count
      shown.formUnion(s.drawn)
      if opening {
        if !canvas.pictureShown, s.drawn.isEmpty, r.allDrawnMs == nil { r.blankFrames += 1 }
        if r.pictureMs == nil, canvas.pictureShown, let at = canvas.pictureShownAt {
          r.pictureMs = ((at - t0) * 1000).rounded()
        }
        if !installed, s.inView > 0, !canvas.isOpening {
          installed = true
          r.installedMs = ms()
        }
        if r.firstContentMs == nil {
          if s.drawn.isEmpty {
            r.blankFramesBeforeContent += 1
            if installed { r.blankFramesAfterInstall += 1 }
          } else {
            r.firstContentMs = ms()
          }
        } else if !blank.isEmpty {
          r.filledLaterFrames += 1
        }
        if r.firstContentMs != nil, r.allDrawnMs == nil, s.inView > 0, blank.isEmpty { r.allDrawnMs = ms() }
        let n = canvas.noteProgress
        if r.notesSharpMs == nil, installed, n.sharp == n.inView, canvas.isSettled { r.notesSharpMs = ms() }
      }
    }
    var emptyAfterContent = Set<Int>()
    var paperAfterContent = Set<Int>()
    onFrame = { sample(&opening, opening: true) }
    try await canvas.show(b, in: vault, theme: .warmInk)
    await frames(
      until: { r.notesSharpMs != nil && r.allDrawnMs != nil },
      each: {
        sample(&opening, opening: true)
        if r.firstContentMs != nil {
          let s = self.canvas.blankInView
          emptyAfterContent.formUnion(s.empty)
          paperAfterContent.formUnion(s.paper)
        }
      })
    r.filledLater = emptyAfterContent.union(paperAfterContent).count
    r.filledLaterEmpty = emptyAfterContent.count
    r.filledLaterPaper = paperAfterContent.count
    let afterOpen = canvas.ruleBreaks
    opening.redraws = afterOpen.redraws - base.redraws
    opening.swaps = afterOpen.swaps - base.swaps
    opening.noteSwaps = afterOpen.noteSwaps - base.noteSwaps
    r.opening = opening
    r.cards = canvas.cardRects.count
    // a pan across the board at 100 %, then a zoom from 50 % to 200 % around the middle, each 2 s; then rest
    let bb = canvas.boardBounds
    canvas.place(zoom: 1, centre: CGPoint(x: bb.minX + canvas.bounds.width / 2, y: bb.midY))
    await frames(until: { self.canvas.isSettled }, each: {})
    for name in ["pan", "zoom"] {
      var p = Phase()
      if name == "zoom" {
        canvas.place(zoom: 0.5, centre: CGPoint(x: bb.midX, y: bb.midY))
        await frames(until: { self.canvas.isSettled }, each: {})
      }
      shown = Set(canvas.blankInView.drawn)
      let before = canvas.ruleBreaks
      let start = CACurrentMediaTime()
      var last = start
      let centre = CGPoint(x: canvas.bounds.midX, y: canvas.bounds.midY)
      await frames(
        until: { CACurrentMediaTime() - start > 2.1 },
        each: {
          let now = CACurrentMediaTime()
          let t = now - start
          let dt = max(now - last, 1.0 / 240)
          last = now
          if name == "pan" {
            let span = max(bb.width - self.canvas.bounds.width, self.canvas.bounds.width)
            self.canvas.scroll(
              by: CGVector(dx: t < 2 ? -span / 2 * dt : 0, dy: 0), at: now, began: t == 0 || p.frames == 0,
              ended: t >= 2)
          } else {
            let k = min(t / 2, 1)
            let target = 0.5 * pow(4, k)
            self.canvas.pinch(
              by: target / self.canvas.zoom, around: centre, at: now, began: p.frames == 0, ended: k >= 1)
          }
          sample(&p, opening: false)
        })
      let after = canvas.ruleBreaks
      p.redraws = after.redraws - before.redraws
      p.swaps = after.swaps - before.swaps
      p.noteSwaps = after.noteSwaps - before.noteSwaps
      if name == "pan" { r.pan = p } else { r.zoom = p }
      await frames(until: { self.canvas.isSettled }, each: {})
    }
    let e = JSONEncoder()
    e.keyEncodingStrategy = .convertToSnakeCase
    e.outputFormatting = [.sortedKeys]
    return String(decoding: try e.encode(r), as: UTF8.self)
  }
}
