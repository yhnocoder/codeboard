import AppKit
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
    demo.window.setContentSize(CGSize(width: 920, height: 820))
    demo.window.setFrameOrigin(CGPoint(x: -30000, y: -30000))
    demo.window.orderBack(nil)
    rest("shown")
    rest("shown, again")
    demo.window.orderOut(nil)
    if let last = idle.last, (last["process"] as? Double ?? 0) > 0.5 {
      failures.append("\(last["process"] ?? 0) % CPU at rest")
    }
    (demo.resources.math as? JSEngines)?.trim()
    stage("engines trimmed to one and collected")
    let result: [String: Any] = [
      "stages": stages, "layouts": layouts, "idleCpuPercent": idle, "tickingEditors": ticking,
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
