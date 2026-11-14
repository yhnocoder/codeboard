import AppKit
import CodeBoardMarkdown
import CodeBoardMarkdownUI

/// `MarkdownDemo [file.md] --check <folder>`: what is checked before a demo build is called in place. The window is set
/// up and laid out but never shown; at each of a few widths its whole content is rendered offscreen
/// (window-<width>.png) and the Note's frame is checked to be on screen beside the panel; then the window sits at rest in
/// the static picture for a few seconds and the process's CPU over that time, the editors' running timers and the memory
/// after each stage of starting are written to check.json. Exits 1 when a check fails
@MainActor
enum Check {
  static let widths: [CGFloat] = [1400, 920, 700, 480]

  static func run(_ demo: Demo, out: URL, start: (now: UInt64, peak: UInt64)?) -> Bool {
    try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    var stages: [[String: Any]] = [
      ["stage": "process start", "mb": mb(start?.now ?? 0), "peakMb": mb(start?.peak ?? 0)]
    ]
    func stage(_ name: String) {
      let f = footprint()
      // what holds it, the larger parts
      let parts = Regions.byName().filter { $0.value >= 1_048_576 }.mapValues { mb($0) }
      stages.append(["stage": name, "mb": mb(f?.now ?? 0), "peakMb": mb(f?.peak ?? 0), "by": parts])
    }
    stage("fonts and engines loaded (Demo init)")
    MarkdownAssets.warmUp(math: demo.resources.math)
    stage("warmed up")
    demo.setUp()
    stage("window set up and laid out")
    var failures: [String] = []
    var layouts: [[String: Any]] = []
    for w in widths {
      let (layout, wrong) = lay(demo, width: w)
      layouts.append(layout)
      failures += wrong
      let content = demo.window.contentView!
      autoreleasepool { render(content, to: out.appending(path: "window-\(Int(w)).png")) }
      if w == widths[0] { stage("first offscreen render (\(engines(demo)) engines)") }
    }
    stage("rendered at every width (\(engines(demo)) engines)")
    // at rest: the static picture, nothing pressed; first never shown, then shown as the app shows it (placed off every
    // display, so nothing appears on the screen), where AppKit draws into its layers and display links run
    for c in demo.cards { c.isEditing = false }
    let ticking = demo.cards.filter(\.isTicking).count
    if ticking > 0 { failures.append("\(ticking) editors still tick at rest") }
    var idle: [[String: Any]] = []
    var rests: [String: Any] = [:]
    var ticks: [String: Bool] = [:]
    var moveSettleMs = 0.0
    var bands: [String: String] = [:]
    func rest(_ name: String) {
      let cpu0 = processCPU()
      let main0 = threadCPU()
      let t0 = ProcessInfo.processInfo.systemUptime
      RunLoop.main.run(until: Date(timeIntervalSinceNow: 3))
      let dt = ProcessInfo.processInfo.systemUptime - t0
      idle.append([
        "when": name, "process": ((processCPU() - cpu0) / dt * 1000).rounded() / 10,
        "main": ((threadCPU() - main0) / dt * 1000).rounded() / 10,
      ])
      stage("3 s at rest, \(name)")
    }
    rest("not shown")
    rest("not shown, again")
    // on a real display, as she has it: a window of 920 × 900 on the main screen at its backing scale, nearly
    // transparent and never key (nothing appears to her, nothing takes the keys), where AppKit draws, backs its layers and
    // runs display links as it does for the app
    let screen = NSScreen.main ?? NSScreen.screens[0]
    demo.window.setContentSize(CGSize(width: 920, height: 900))
    demo.window.setFrameOrigin(CGPoint(x: screen.visibleFrame.minX, y: screen.visibleFrame.minY))
    demo.window.alphaValue = 0.01
    // never in the way of her pointer: the real mouse goes through it; the check's own events are posted to the app
    demo.window.ignoresMouseEvents = true
    demo.window.orderFrontRegardless()
    rest("shown")
    let visible = demo.window.occlusionState.contains(.visible)
    let base = footprint()?.now ?? 0
    stage("shown, at rest (scale \(demo.window.backingScaleFactor), visible \(visible))")
    // scrolled top to bottom and back, a frame at a time
    var peak = base
    func frame() {
      // events taken off the app's queue and dispatched as NSApp.run does (monitors included), then a frame's time
      while let ev = NSApp.nextEvent(matching: .any, until: nil, inMode: .default, dequeue: true) {
        NSApp.sendEvent(ev)
      }
      RunLoop.main.run(until: Date(timeIntervalSinceNow: 1.0 / 60))
      peak = max(peak, footprint()?.now ?? 0)
    }
    let clip = demo.scroll.contentView
    let bottom = max(0, demo.page.frame.height - clip.bounds.height)
    for down in [true, false] {
      var y: CGFloat = down ? 0 : bottom
      while down ? y < bottom : y > 0 {
        y = down ? min(bottom, y + 40) : max(0, y - 40)
        clip.scroll(to: CGPoint(x: 0, y: y))
        demo.scroll.reflectScrolledClipView(clip)
        frame()
      }
    }
    stage("scrolled down and up (peak during \(mb(peak)) MB)")
    clip.scroll(to: CGPoint(x: 0, y: bottom / 2))
    demo.scroll.reflectScrolledClipView(clip)
    frame()
    autoreleasepool { render(demo.window.contentView!, to: out.appending(path: "shown-scrolled.png")) }
    // each card at the top of the window, as she scrolls to it (the first eight)
    for (i, r) in demo.page.cardRects.prefix(8).enumerated() {
      clip.scroll(to: CGPoint(x: 0, y: min(bottom, max(0, r.minY - 20))))
      demo.scroll.reflectScrolledClipView(clip)
      frame()
      autoreleasepool { render(demo.window.contentView!, to: out.appending(path: "card-\(i + 1).png")) }
    }
    clip.scroll(to: .zero)
    demo.scroll.reflectScrolledClipView(clip)
    frame()
    rest("after scrolling")
    rest("after scrolling, again")
    let afterScroll = footprint()?.now ?? 0
    // the other things a person does: a click into the Note, typing, zoom, leaving editing
    if let e = demo.cards.first {
      demo.window.makeFirstResponder(e)
      e.enter(at: CGPoint(x: 40, y: 12))
      for ch in "abc" { e.insertText(String(ch), replacementRange: NSRange(location: NSNotFound, length: 0)) }
      frame()
      autoreleasepool { render(demo.window.contentView!, to: out.appending(path: "shown-typed.png")) }
      demo.step(1.25)
      frame()
      demo.zoomActual(nil)
      frame()
      e.isEditing = false
      demo.window.makeFirstResponder(nil)
      frame()
    }
    // a ⌘ move through the app's own event queue (the monitors see it as they see hers): ⌘ over the first card's second
    // block, then a ⌘-drag of it below the third
    if let e = demo.cards.max(by: { $0.core.layout.blockFrames.count < $1.core.layout.blockFrames.count }),
      let content = demo.window.contentView
    {
      demo.window.makeFirstResponder(e)
      e.enter(at: CGPoint(x: 40, y: 12))
      frame()
      let frames = e.core.layout.blockFrames
      func at(_ block: Int) -> CGPoint {
        let r = frames[min(block, frames.count - 1)]
        let inPage = CGPoint(x: e.frame.minX + 30 * demo.zoom, y: e.frame.minY + r.midY * demo.zoom)
        return content.convert(demo.page.convert(inPage, to: content), to: nil)
      }
      func post(_ type: NSEvent.EventType, _ p: CGPoint, _ flags: NSEvent.ModifierFlags = .command) {
        let ev = NSEvent.mouseEvent(
          with: type, location: p, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
          windowNumber: demo.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
          pressure: type == .leftMouseUp ? 0 : 1)!
        NSApp.postEvent(ev, atStart: false)
        frame()
      }
      let before = e.source
      post(.mouseMoved, at(1))
      ticks["outline on ⌘ hover"] = demo.moves.outlineShown
      post(.leftMouseDown, at(1))
      post(.leftMouseDragged, CGPoint(x: at(1).x, y: at(1).y - 20))
      post(.leftMouseDragged, at(3))
      post(.leftMouseUp, at(3))
      // until nothing draws for three frames in a row: how long the move takes to come to rest
      let dropped = ProcessInfo.processInfo.systemUptime
      var still = 0
      var lastDraws = (demo.cards.reduce(0) { $0 + $1.draws }, demo.page.draws, MarkdownEditorView.linkTicks)
      var settled = 0.0
      for _ in 0..<120 {
        frame()
        let now = (demo.cards.reduce(0) { $0 + $1.draws }, demo.page.draws, MarkdownEditorView.linkTicks)
        if now == lastDraws {
          still += 1
        } else {
          still = 0
          settled = ProcessInfo.processInfo.systemUptime - dropped
        }
        lastDraws = now
        if still >= 3 { break }
      }
      moveSettleMs = (settled * 1000).rounded()
      ticks["⌘-drag moved a block"] = e.source != before
      e.undo(nil)
      // across Notes, then one Undo from the source Note: both Notes as they were
      // the Note just above, both in view: the source's top at the window's middle
      let i = demo.cards.firstIndex { $0 === e } ?? 0
      if i > 0, demo.cards[i - 1].core.layout.blockFrames.count > 1 {
        let f = demo.cards[i - 1]
        let fromBefore = e.source
        let toBefore = f.source
        clip.scroll(to: CGPoint(x: 0, y: max(0, e.frame.minY - clip.bounds.height / 2)))
        demo.scroll.reflectScrolledClipView(clip)
        frame()
        let fr = f.core.layout.blockFrames
        let into = content.convert(
          demo.page.convert(
            CGPoint(x: f.frame.minX + 30 * demo.zoom, y: f.frame.minY + fr[fr.count - 1].midY * demo.zoom), to: content),
          to: nil)
        post(.leftMouseDown, at(1))
        post(.leftMouseDragged, CGPoint(x: at(1).x, y: at(1).y - 20))
        post(.leftMouseDragged, into)
        post(.leftMouseUp, into)
        for _ in 0..<24 { frame() }
        let moved = e.source != fromBefore && f.source != toBefore
        ticks["⌘-drag across Notes moved the block"] = moved
        demo.window.makeFirstResponder(e)
        // the action Edit > Undo (⌘Z) sends: the window is never key, so its keys would go to her front window
        e.undo(nil)
        for _ in 0..<6 { frame() }
        ticks["⌘-drag across Notes, then one Undo restores both"] =
          moved && e.source == fromBefore && f.source == toBefore
      }
      e.isEditing = false
      demo.window.makeFirstResponder(nil)
      frame()
      for (k, v) in ticks where !v { failures.append("\(k): no") }
    }
    // a picture selected by a click, then resized by its right grip, through the app's own event queue
    if let e = demo.cards.first(where: { !$0.core.layout.images.isEmpty }), let content = demo.window.contentView,
      let slot = e.core.layout.images.first
    {
      func win(_ q: CGPoint) -> CGPoint {
        content.convert(
          demo.page.convert(CGPoint(x: e.frame.minX + q.x * demo.zoom, y: e.frame.minY + q.y * demo.zoom), to: content),
          to: nil)
      }
      // to the view under the point, as the window would hand them over: the check's window is never key, and a first
      // click in a window that is not key only activates it
      func click(_ type: NSEvent.EventType, _ q: CGPoint) {
        let ev = NSEvent.mouseEvent(
          with: type, location: win(q), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
          windowNumber: demo.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
          pressure: type == .leftMouseUp ? 0 : 1)!
        let hit = content.hitTest(content.convert(win(q), from: nil)) ?? e
        switch type {
        case .leftMouseDown: hit.mouseDown(with: ev)
        case .leftMouseDragged: hit.mouseDragged(with: ev)
        default: hit.mouseUp(with: ev)
        }
        frame()
      }
      clip.scroll(to: CGPoint(x: 0, y: max(0, e.frame.minY + slot.frame.minY * demo.zoom - 120)))
      demo.scroll.reflectScrolledClipView(clip)
      frame()
      let mid = CGPoint(x: slot.frame.midX, y: slot.frame.midY)
      // one click: it enters editing with the picture selected (a second click on it would open its source)
      click(.leftMouseDown, mid)
      click(.leftMouseUp, mid)
      for _ in 0..<30 { frame() }
      ticks["a click selects the picture"] = e.core.selectedImage != nil
      autoreleasepool { render(content, to: out.appending(path: "image-selected.png")) }
      let g = CGPoint(x: slot.frame.maxX, y: slot.frame.midY)
      click(.leftMouseDown, g)
      click(.leftMouseDragged, CGPoint(x: g.x - 40, y: g.y))
      click(.leftMouseUp, CGPoint(x: g.x - 40, y: g.y))
      for _ in 0..<10 { frame() }
      ticks["a grip resizes and the picture stays selected"] = e.core.selectedImage != nil
      autoreleasepool { render(content, to: out.appending(path: "image-resized.png")) }
      e.undo(nil)
      e.isEditing = false
      frame()
      for (k, v) in ticks where !v && k.contains("picture") { failures.append("\(k): no") }
    }
    // the bands: the caret in a table, then in a code block, each band rendered where she sees it
    if let e = demo.cards.first(where: { $0.source.contains("|---") || $0.source.contains("|:--") }),
      let content = demo.window.contentView
    {
      demo.window.makeFirstResponder(e)
      e.isEditing = true
      let ns = e.source as NSString
      for (what, needle) in [("table", "| prefill"), ("code", "def step")] {
        let at = ns.range(of: needle).location
        guard at != NSNotFound else { continue }
        e.selection = MDSelection(at + 3)
        let caret = e.core.caretRect.map { $0.minY * demo.zoom } ?? 0
        clip.scroll(to: CGPoint(x: 0, y: max(0, e.frame.minY + caret - 260)))
        demo.scroll.reflectScrolledClipView(clip)
        for _ in 0..<20 { frame() }
        autoreleasepool { render(content, to: out.appending(path: "band-\(what).png")) }
        bands[what] = e.bandGeometry
      }
      e.isEditing = false
      frame()
    }
    rest("after click, typing, zoom, leaving")
    rest("after click, typing, zoom, leaving, again")
    let afterAll = footprint()?.now ?? 0
    let counts = (demo.cards.reduce(0) { $0 + $1.draws }, demo.page.draws, MarkdownEditorView.linkTicks)
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 2))
    let still = (
      demo.cards.reduce(0) { $0 + $1.draws } - counts.0, demo.page.draws - counts.1,
      MarkdownEditorView.linkTicks - counts.2
    )
    demo.window.orderOut(nil)
    let budget: UInt64 = 8 << 20
    let grown = [("scrolling", afterScroll), ("all of it", afterAll)].map { ($0.0, Int64($0.1) - Int64(base)) }
    // reported, not failed on: the memory work is parked (guideline 6.5)
    let overBudget = grown.filter { $0.1 > Int64(budget) }.map(\.0)
    if still != (0, 0, 0) {
      failures.append("at rest in 2 s: \(still.0) Note draws, \(still.1) paper draws, \(still.2) link frames")
    }
    for r in idle.filter({ ($0["when"] as? String ?? "").hasSuffix("again") })
    where (r["process"] as? Double ?? 0) > 0.5 {
      failures.append("\(r["process"] ?? 0) % CPU at rest (\(r["when"] ?? ""))")
    }
    rests = [
      "visible": visible, "overMemoryBudget": overBudget,
      "grownMb": Dictionary(uniqueKeysWithValues: grown.map { ($0.0, Double($0.1) / 1_048_576) }),
    ]
    (demo.resources.math as? JSEngines)?.trim()
    stage("engines trimmed to one and collected")
    let result: [String: Any] = [
      "stages": stages, "layouts": layouts, "idleCpuPercent": idle, "tickingEditors": ticking, "onScreen": rests,
      "events": ticks, "moveSettleMs": moveSettleMs, "bands": bands,
      "failures": failures,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
      try? data.write(to: out.appending(path: "check.json"))
      print(String(decoding: data, as: UTF8.self))
    }
    return failures.isEmpty
  }

  /// this thread's CPU time so far, seconds
  static func threadCPU() -> Double {
    var t = timespec()
    clock_gettime(CLOCK_THREAD_CPUTIME_ID, &t)
    return Double(t.tv_sec) + Double(t.tv_nsec) / 1e9
  }

  static func engines(_ demo: Demo) -> Int { (demo.resources.math as? JSEngines)?.engineCount ?? 0 }

  /// The window at a width: where the Notes' column, the first card and the panel are, and what is wrong with that: the
  /// card not wholly in view across, or the panel wider than a third of the window
  static func lay(_ demo: Demo, width w: CGFloat) -> ([String: Any], [String]) {
    demo.window.setContentSize(CGSize(width: w, height: 820))
    demo.window.contentView?.layoutSubtreeIfNeeded()
    let content = demo.window.contentView!
    let notes = demo.scroll.convert(demo.scroll.bounds, to: content)
    let card = content.convert(demo.page.cardRect, from: demo.page)
    let seen = card.intersection(notes)
    let panel = demo.columns.shownPanel
    var wrong: [String] = []
    if card.isEmpty || seen.width < min(card.width, notes.width) - 1 || seen.height <= 0 {
      wrong.append("at \(Int(w)) pt the Note is not in view beside the panel")
    }
    if panel > w / 3 + 0.5 { wrong.append("at \(Int(w)) pt the panel is wider than a third") }
    return (["width": Double(w), "notes": rect(notes), "card": rect(card), "panel": Double(panel)], wrong)
  }

  static func mb(_ b: UInt64) -> Double { (Double(b) / 1_048_576 * 10).rounded() / 10 }

  static func rect(_ r: CGRect) -> [Double] { [r.minX, r.minY, r.width, r.height].map { Double($0) } }

  /// the view and everything in it, as the window would show it, at 2x
  static func render(_ v: NSView, to url: URL) {
    guard let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
    v.cacheDisplay(in: v.bounds, to: rep)
    try? rep.representation(using: .png, properties: [:])?.write(to: url)
  }
}

/// This process's own memory by what allocated it (the VM region's tag), in bytes of private dirty and compressed pages:
/// roughly what makes up phys_footprint. Read from its own address space; no tool looks into it
enum Regions {
  static let names: [Int: String] = [
    1: "malloc", 2: "malloc", 3: "malloc", 4: "malloc", 7: "malloc", 8: "malloc", 9: "malloc", 11: "malloc",
    12: "malloc", 21: "IOKit", 30: "stacks", 33: "dylibs", 41: "Foundation", 42: "CoreGraphics", 50: "fonts (ATS)",
    51: "Core Animation", 52: "CGImage", 54: "CoreGraphics", 55: "CoreGraphics", 56: "CoreGraphics",
    57: "window backing stores", 58: "CoreGraphics", 60: "dyld", 61: "dyld", 63: "JavaScriptCore",
    64: "JavaScriptCore JIT", 65: "JavaScriptCore", 70: "ImageIO", 73: "os", 74: "libdispatch", 75: "Accelerate",
    82: "Swift runtime", 83: "Swift runtime", 88: "IOSurface",
  ]

  static func byName() -> [String: UInt64] {
    var out: [String: UInt64] = [:]
    var address: mach_vm_address_t = 0
    var size: mach_vm_size_t = 0
    var depth: natural_t = 0
    let page = UInt64(getpagesize())
    while true {
      var info = vm_region_submap_info_data_64_t()
      var count = mach_msg_type_number_t(
        MemoryLayout<vm_region_submap_info_data_64_t>.size / MemoryLayout<natural_t>.size)
      let kr = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
          mach_vm_region_recurse(mach_task_self_, &address, &size, &depth, $0, &count)
        }
      }
      guard kr == KERN_SUCCESS else { break }
      if info.is_submap != 0 {
        depth += 1
        continue
      }
      let mode = Int32(info.share_mode)
      if mode != SM_EMPTY {
        let bytes = UInt64(info.pages_dirtied + info.pages_swapped_out) * page
        if bytes > 0 {
          let tag = Int(info.user_tag)
          out[names[tag] ?? "tag \(tag)", default: 0] += bytes
        }
      }
      address += size
    }
    return out
  }
}
