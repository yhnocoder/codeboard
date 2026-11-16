import AppKit
import MarkdownCore
import MarkdownUI

/// The panel at the window's right: the selection in source offsets and the caret's block as source, what the editor
/// last copied and pasted, and its last 50 events, newest first, each with the main thread's time it cost. It reads
/// only the editor's own events (MarkdownEditorView.observer): never the system clipboard. The HUD at its top is a label
/// of its own, so its once-a-second numbers never lay the rest out again
@MainActor
final class Inspector: NSView {
  private let scroll = NSScrollView()
  private let text = NSTextView()
  private let hudLabel = NSTextField(labelWithString: "")
  /// the editor's events, newest first: when, what, its main-thread cost (the last 200 kept for a report, 50 shown)
  private var events: [(at: Date, line: String, ms: Double)] = []
  private var copied: [(type: String, text: String)] = []
  private var pasted: (String, String)?
  private weak var editor: MarkdownEditorView?
  private var queued = false
  /// the HUD's numbers, sampled once a second while the panel is open
  private var hud = ""
  private var sampler: Timer?
  private var lastCPU = (cpu: 0.0, wall: 0.0)
  /// the Notes' draws, the paper's draws and display-link frames so far (the demo's), and at the last sample
  var counts: () -> (notes: Int, paper: Int, ticks: Int) = { (0, 0, 0) }
  private var lastCounts = (notes: 0, paper: 0, ticks: 0)
  /// the window, zoom, look and appearance, for a report (the demo's)
  var context: () -> String = { "" }
  /// a line more for the HUD (the last card-width drag's numbers)
  var extra: () -> String? = { nil }
  /// memory by what holds it, measured when asked (walking the address space costs tens of ms: never per second)
  private var parts = ""
  private let copyButton = NSButton(title: "Copy report", target: nil, action: nil)
  private let partsButton = NSButton(title: "Memory parts", target: nil, action: nil)
  /// nil before the first key
  private var lastKeyMs: Double?

  init() {
    super.init(frame: CGRect(x: 0, y: 0, width: 300, height: 600))
    wantsLayer = true
    layer?.backgroundColor = NSColor.textBackgroundColor.cgColor
    hudLabel.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
    hudLabel.maximumNumberOfLines = 7
    hudLabel.lineBreakMode = .byTruncatingTail
    hudLabel.frame = CGRect(x: 14, y: 600 - 92, width: 300 - 28, height: 82)
    hudLabel.autoresizingMask = [.width, .minYMargin]
    addSubview(hudLabel)
    for (i, b) in [copyButton, partsButton].enumerated() {
      b.bezelStyle = .push
      b.controlSize = .small
      b.font = .systemFont(ofSize: 11)
      b.target = self
      b.frame = CGRect(x: 10 + CGFloat(i) * 112, y: 600 - 120, width: 108, height: 24)
      b.autoresizingMask = [.minYMargin]
      addSubview(b)
    }
    copyButton.action = #selector(copyReport(_:))
    partsButton.action = #selector(measureParts(_:))
    scroll.frame = CGRect(x: 0, y: 0, width: 300, height: 600 - 124)
    scroll.autoresizingMask = [.width, .height]
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = false
    text.isEditable = false
    text.isRichText = true
    text.drawsBackground = false
    text.textContainerInset = CGSize(width: 10, height: 4)
    text.autoresizingMask = [.width]
    scroll.documentView = text
    addSubview(scroll)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  /// Starts watching an editor (its observer is the panel's while the panel is shown)
  func watch(_ e: MarkdownEditorView?) {
    editor?.observer = nil
    editor = e
    attach()
    refresh()
  }

  override var isHidden: Bool {
    didSet {
      attach()
      sampleSoon()
    }
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    attach()
    sampleSoon()
  }

  /// the HUD samples once a second while the panel shows in a window, nothing while it is hidden
  private func sampleSoon() {
    sampler?.invalidate()
    sampler = nil
    guard !isHidden, window != nil else { return }
    sample()
    sampler = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.sample() }
    }
  }

  private func sample() {
    let cpu = processCPU()
    let wall = ProcessInfo.processInfo.systemUptime
    let pct = lastCPU.wall > 0 ? (cpu - lastCPU.cpu) / max(0.001, wall - lastCPU.wall) * 100 : 0
    lastCPU = (cpu, wall)
    let mb = { (b: UInt64) in String(format: "%.0f MB", Double(b) / 1_048_576) }
    let mem = footprint().map { "\(mb($0.now)) (peak \(mb($0.peak)))" } ?? "?"
    let draw = editor.flatMap { $0.lastDrawMs > 0 ? String(format: "%.2f ms", $0.lastDrawMs) : nil } ?? "–"
    let key = lastKeyMs.map { String(format: "%.2f ms", $0) } ?? "–"
    let c = counts()
    let per = String(
      format: "draws/s %d (paper %d)   link frames/s %d", c.notes - lastCounts.notes, c.paper - lastCounts.paper,
      c.ticks - lastCounts.ticks)
    lastCounts = c
    let next =
      String(format: "memory %@   CPU %.0f %%\n%@\nlast key %@   last frame %@\n%@", mem, pct, parts, key, draw, per)
      + (extra().map { "\n" + $0 } ?? "")
    // the panel is laid out again only when a number changed: the HUD must not cost what it measures
    guard next != hud else { return }
    hud = next
    hudLabel.stringValue = "This process\n" + next
  }

  /// observing costs only while the panel is shown
  private func attach() {
    guard let e = editor else { return }
    e.observer =
      isHidden
      ? nil
      : { [weak self] event, ms in
        guard let self else { return }
        switch event {
        case .copied(let t): self.copied = t
        case .pasted(let t, let rule): self.pasted = (t, rule)
        default: break
        }
        if case .key = event { self.lastKeyMs = ms }
        self.events.insert((Date(), event.line, ms), at: 0)
        if self.events.count > 200 { self.events.removeLast(self.events.count - 200) }
        self.refreshSoon()
      }
  }

  func refreshSoon() {
    guard !queued else { return }
    queued = true
    DispatchQueue.main.async { [weak self] in
      self?.queued = false
      self?.refresh()
    }
  }

  @objc func measureParts(_ s: Any?) {
    parts = Regions.byName().filter { $0.value >= 2 << 20 }.sorted { $0.value > $1.value }
      .map { "\($0.key) \($0.value >> 20) MB" }.joined(separator: " · ")
    refresh()
  }

  /// A plain-text report of what the panel knows, on the pasteboard, only on a click of its button: the build, the
  /// window, the HUD, the selection and caret's block, what was copied and pasted, memory parts and the events oldest
  /// first
  @objc func copyReport(_ s: Any?) {
    measureParts(nil)
    let info = Bundle.main.infoDictionary ?? [:]
    var lines = [
      "Markdown Demo \(info["CodeBoardCommit"] as? String ?? "dev build") built \(info["CodeBoardBuilt"] as? String ?? "?")",
      context(), hud.replacingOccurrences(of: "\n", with: "  ·  "), "memory parts: \(parts)",
    ]
    if let e = editor {
      let sel = e.core.selection
      lines.append("\(e.isEditing ? "editing" : "display"), selection anchor \(sel.anchor) head \(sel.head)")
      if let bi = MarkdownEditing.blockHolding(sel.head, in: e.core.document) {
        let r = e.core.document.blocks[bi].range
        lines.append("caret's block \(r.lowerBound)..<\(r.upperBound):")
        lines.append((e.core.source as NSString).substring(with: NSRange(location: r.lowerBound, length: r.count)))
      }
    }
    for c in copied { lines.append("copied \(c.type): \(c.text)") }
    if let (t, rule) = pasted { lines.append("pasted (\(rule)): \(t)") }
    lines.append("events, oldest first:")
    let time = DateFormatter()
    time.dateFormat = "HH:mm:ss.SSS"
    for e in events.reversed() {
      lines.append(String(format: "%@ %6.2f ms  %@", time.string(from: e.at), e.ms, e.line))
    }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(lines.joined(separator: "\n"), forType: .string)
  }

  func refresh() {
    guard !isHidden else { return }
    let out = NSMutableAttributedString()
    let head = NSFont.systemFont(ofSize: 11, weight: .semibold)
    let body = NSFont.systemFont(ofSize: 11)
    let mono = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    let ink = NSColor.labelColor
    let faint = NSColor.secondaryLabelColor
    func add(_ s: String, _ f: NSFont, _ c: NSColor = ink) {
      out.append(NSAttributedString(string: s, attributes: [.font: f, .foregroundColor: c]))
    }
    if let e = editor {
      let core = e.core
      let s = core.selection
      add("Selection\n", head)
      add("anchor \(s.anchor)  head \(s.head)  \(e.isEditing ? "editing" : "display")\n", mono)
      if let m = core.marked { add("marked \"\(m.text)\" at \(m.at)\n", mono) }
      if let bi = MarkdownEditing.blockHolding(s.head, in: core.document) {
        let r = core.document.blocks[bi].range
        add("\nCaret's block \(r.lowerBound)..<\(r.upperBound)\n", head)
        add((core.source as NSString).substring(with: NSRange(location: r.lowerBound, length: r.count)) + "\n", mono)
      }
    }
    add("\nCopied\n", head)
    if copied.isEmpty { add("nothing yet\n", body, faint) }
    for c in copied {
      add(c.type + "\n", body, faint)
      add(c.text + "\n", mono)
    }
    if let (t, rule) = pasted {
      add("\nPasted (\(rule))\n", head)
      add(t + "\n", mono)
    }
    if !parts.isEmpty {
      add("\nMemory parts\n", head)
      add(parts + "\n", mono)
    }
    add("\nEvents\n", head)
    for e in events.prefix(50) {
      add(String(format: "%6.2f ms  ", e.ms), mono, faint)
      add(e.line + "\n", mono)
    }
    text.textStorage?.setAttributedString(out)
  }
}

/// the process's memory as Activity Monitor counts it (phys_footprint), now and at its peak, in bytes
func footprint() -> (now: UInt64, peak: UInt64)? {
  var info = task_vm_info_data_t()
  var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
  let ok = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
      task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
    }
  }
  guard ok == KERN_SUCCESS else { return nil }
  return (info.phys_footprint, UInt64(max(0, info.ledger_phys_footprint_peak)))
}

/// the process's CPU time so far, every thread, in seconds
func processCPU() -> Double {
  var ru = rusage()
  getrusage(RUSAGE_SELF, &ru)
  return Double(ru.ru_utime.tv_sec + ru.ru_stime.tv_sec) + Double(ru.ru_utime.tv_usec + ru.ru_stime.tv_usec) / 1e6
}
