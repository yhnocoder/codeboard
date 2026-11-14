import AppKit
import CodeBoardMarkdown
import CodeBoardMarkdownUI

/// The panel at the window's right: the selection in source offsets and the caret's block as source, what the editor
/// last copied and pasted, and its last 50 events, newest first, each with the main thread's time it cost. It reads
/// only the editor's own events (MarkdownEditorView.observer): never the system clipboard
@MainActor
final class Inspector: NSScrollView {
  private let text = NSTextView()
  private var events: [(String, Double)] = []
  private var copied: [(type: String, text: String)] = []
  private var pasted: (String, String)?
  private weak var editor: MarkdownEditorView?
  private var queued = false
  /// the HUD's numbers, sampled once a second while the panel is open
  private var hud = ""
  private var sampler: Timer?
  private var lastCPU = (cpu: 0.0, wall: 0.0)
  private var lastKeyMs = 0.0

  init() {
    super.init(frame: CGRect(x: 0, y: 0, width: 320, height: 600))
    hasVerticalScroller = true
    text.isEditable = false
    text.isRichText = true
    text.textContainerInset = CGSize(width: 10, height: 10)
    text.autoresizingMask = [.width]
    documentView = text
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

  /// the HUD samples once a second while the panel shows, nothing while it is hidden
  private func sampleSoon() {
    sampler?.invalidate()
    sampler = nil
    guard !isHidden else { return }
    sample()
    sampler = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.sample() }
    }
  }

  private func sample() {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let ok = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    var ru = rusage()
    getrusage(RUSAGE_SELF, &ru)
    let cpu = Double(ru.ru_utime.tv_sec + ru.ru_stime.tv_sec) + Double(ru.ru_utime.tv_usec + ru.ru_stime.tv_usec) / 1e6
    let wall = ProcessInfo.processInfo.systemUptime
    let pct = lastCPU.wall > 0 ? (cpu - lastCPU.cpu) / max(0.001, wall - lastCPU.wall) * 100 : 0
    lastCPU = (cpu, wall)
    let mb = { (b: UInt64) in String(format: "%.0f MB", Double(b) / 1_048_576) }
    let mem =
      ok == KERN_SUCCESS
      ? "\(mb(info.phys_footprint)) (peak \(mb(UInt64(max(0, info.ledger_phys_footprint_peak)))))" : "?"
    let draw = editor.map { String(format: "%.2f ms", $0.lastDrawMs) } ?? "–"
    hud = String(format: "memory %@   CPU %.0f %%\nlast key %.2f ms   last frame %@", mem, pct, lastKeyMs, draw)
    refreshSoon()
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
        self.events.insert((event.line, ms), at: 0)
        if self.events.count > 50 { self.events.removeLast(self.events.count - 50) }
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
    add("This process\n", head)
    add(hud + "\n\n", mono)
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
    add("\nEvents\n", head)
    for (line, ms) in events {
      add(String(format: "%6.2f ms  ", ms), mono, faint)
      add(line + "\n", mono)
    }
    text.textStorage?.setAttributedString(out)
  }
}
