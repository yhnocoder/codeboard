import AppKit
import CodeBoardModel
import CodeBoardResources
import PDFKit

// A PDF tab's versions bar: at the bottom middle of the tab, in the board toolbar's look, when the entry has versions to
// switch between or is an arXiv paper. A segment per version (the one shown lit), "+ 译文" while the version shown has
// no translation, the translation running or failed, and ⋯ (Check for New Version). Nothing above the page.

/// What the bar shows
struct VersionsShown: Equatable {
  struct Segment: Equatable {
    var id: VersionID
    var label: String
  }

  var segments: [Segment]
  var shown: VersionID
  /// "+ 译文": enabled, or why not
  var translate: Offer?
  var job: TranslationState?

  enum Offer: Equatable {
    case yes
    case no(String)
  }
}

final class VersionsBar: NSView {
  var look: ReadingBarLook {
    didSet { needsLayout = true }
  }
  private let glass = NSVisualEffectView()
  private let tint = NSView()
  private(set) var segments: [BarButton] = []
  private(set) var translate: BarButton?
  private(set) var job: BarButton?
  private let jobLine = CALayer()
  let more = BarButton(radius: 8.5)
  private(set) var shown: VersionsShown?
  var onSelect: (VersionID) -> Void = { _ in }
  var onTranslate: () -> Void = {}
  var onJob: () -> Void = {}
  var onMore: (NSView) -> Void = { _ in }

  init(look: ReadingBarLook) {
    self.look = look
    super.init(frame: .zero)
    setAccessibilityIdentifier("ui-versionbar")
    setAccessibilityElement(true)
    setAccessibilityRole(.toolbar)
    wantsLayer = true
    more.image = NSImage(systemSymbolName: "ellipsis", accessibilityDescription: "More")
    more.toolTip = "More"
    more.setAccessibilityIdentifier("ui-versionmore")
    more.target = self
    more.action = #selector(pressedMore)
    for v in [glass, tint, more] { addSubview(v) }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("VersionsBar is not loaded from nibs") }

  override var isFlipped: Bool { true }

  /// Its items made again for `s`
  func show(_ s: VersionsShown) {
    guard s != shown else { return }
    shown = s
    for b in segments + [translate, job].compactMap({ $0 }) { b.removeFromSuperview() }
    segments = s.segments.enumerated().map { i, seg in
      let b = textButton(seg.label, id: "ui-version\(i + 1)")
      b.on = seg.id == s.shown
      b.tag = i
      b.action = #selector(pressedSegment(_:))
      return b
    }
    translate = s.translate.map { offer in
      let b = textButton("+ 译文", id: "ui-versiontranslate")
      b.action = #selector(pressedTranslate)
      if case .no(let why) = offer {
        b.isEnabled = false
        b.toolTip = why
      }
      return b
    }
    job = s.job.map { state in
      let b = textButton(Self.jobTitle(state), id: "ui-versionjob")
      b.action = #selector(pressedJob)
      if case .failed = state { b.toolTip = "The translation failed: click for why, and Retry" }
      b.layer?.addSublayer(jobLine)
      return b
    }
    setFrameSize(size)
    needsLayout = true
  }

  /// What the job's item says
  static func jobTitle(_ s: TranslationState) -> String {
    switch s {
    case .waiting: "译文 · waiting"
    case .running(let p): "译文 · \(p.stage)" + (p.fraction.map { " \(Int(($0 * 100).rounded()))%" } ?? "")
    case .failed: "译文 · failed"
    }
  }

  private var items: [NSView] { segments + [job, translate].compactMap { $0 } + [more] }

  private func width(_ v: NSView) -> CGFloat {
    guard let b = v as? NSButton, b !== more else { return look.button.width }
    return (b.attributedTitle.size().width + 16).rounded()
  }

  /// Its items side by side, 4 in and 2 apart, as the board toolbar's
  var size: CGSize {
    let w = items.reduce(8) { $0 + width($1) } + CGFloat(max(0, items.count - 1)) * 2
    return CGSize(width: w, height: look.height)
  }

  override func layout() {
    super.layout()
    for b in items.compactMap({ $0 as? BarButton }) { restyle(b) }
    let y = ((bounds.height - look.button.height) / 2).rounded()
    var x: CGFloat = 4
    for v in items {
      v.frame = CGRect(x: x, y: y, width: width(v), height: look.button.height)
      x += width(v) + 2
    }
    SelectionBar.paint(self, glass: glass, tint: tint, look: look)
    if let job, let state = shown?.job {
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      let w = job.bounds.width - 8
      switch state {
      case .running(let p):
        jobLine.isHidden = false
        jobLine.backgroundColor = look.accent
        jobLine.opacity = p.fraction == nil ? 0.35 : 1
        jobLine.frame = CGRect(x: 4, y: job.bounds.height - 3, width: w * (p.fraction ?? 1), height: 1.5)
      default: jobLine.isHidden = true
      }
      CATransaction.commit()
    }
  }

  private func textButton(_ title: String, id: String) -> BarButton {
    let b = BarButton(radius: look.buttonRadius)
    b.imagePosition = .noImage
    b.title = title
    b.setAccessibilityIdentifier(id)
    b.setAccessibilityLabel(title)
    b.target = self
    restyle(b)
    addSubview(b)
    return b
  }

  private func restyle(_ b: BarButton) {
    b.ink(look)
    guard b !== more else { return }
    let failed = b === job && { if case .failed? = shown?.job { true } else { false } }()
    b.base = failed ? NSColor.systemRed.withAlphaComponent(0.14).cgColor : nil
    // "+ 译文" an action in the bar's secondary ink, lighter than the segment lit
    let plain = NSColor(cgColor: look.ink) ?? .labelColor
    let ink = failed ? NSColor.systemRed : b === translate ? plain.withAlphaComponent(0.62) : plain
    b.attributedTitle = NSAttributedString(
      string: b.title,
      attributes: [
        .font: NSFont.systemFont(ofSize: 12, weight: b.on ? .semibold : .regular),
        .foregroundColor: b.isEnabled ? ink : ink.withAlphaComponent(0.4),
      ])
  }

  @objc private func pressedSegment(_ sender: NSButton) {
    if let s = shown, s.segments.indices.contains(sender.tag) { onSelect(s.segments[sender.tag].id) }
  }
  @objc private func pressedTranslate() { onTranslate() }
  @objc private func pressedJob() { onJob() }
  @objc private func pressedMore() { onMore(more) }
}

/// A few words above the versions bar: why a translation failed (with Retry), how one is going (with Cancel), what
/// Check for New Version found. A click on its button does that and it goes
final class VersionNote: NSView {
  let text = NSTextField(wrappingLabelWithString: "")
  let button = NSButton(title: "", target: nil, action: nil)
  private var run: () -> Void = {}

  init() {
    super.init(frame: .zero)
    wantsLayer = true
    setAccessibilityIdentifier("ui-versionnote")
    text.isSelectable = true
    text.font = .systemFont(ofSize: 12)
    button.bezelStyle = .push
    button.controlSize = .small
    button.target = self
    button.action = #selector(pressed)
    for v in [text, button] { addSubview(v) }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("VersionNote is not loaded from nibs") }

  override var isFlipped: Bool { true }

  /// `message`, and a button `action` (its title, identifier and what it does) when there is one
  func show(_ message: String, action: (title: String, id: String, run: () -> Void)?, look: ReadingBarLook) {
    text.stringValue = message
    text.textColor = NSColor(cgColor: look.ink)
    layer?.backgroundColor = look.paper
    layer?.borderColor = look.ring
    layer?.borderWidth = 0.5
    layer?.cornerRadius = max(look.radius, 6)
    appearance = NSAppearance(named: look.dark ? .darkAqua : .aqua)
    button.isHidden = action == nil
    button.title = action?.title ?? ""
    button.setAccessibilityIdentifier(action?.id)
    run = action?.run ?? {}
    let w: CGFloat = 320
    text.preferredMaxLayoutWidth = w - 24
    let h = text.sizeThatFits(CGSize(width: w - 24, height: 1000)).height
    text.frame = CGRect(x: 12, y: 10, width: w - 24, height: h)
    button.sizeToFit()
    button.frame.origin = CGPoint(x: w - 12 - button.frame.width, y: 10 + h + 8)
    setFrameSize(CGSize(width: w, height: 10 + h + (action == nil ? 10 : 8 + button.frame.height + 10)))
  }

  @objc private func pressed() { run() }
}

extension PDFTabView {
  /// The arXiv id of the tab's entry, when it is a paper from there
  var arxivID: String? {
    if case .arxiv(let id)? = entry?.origin { return id }
    return nil
  }

  /// The version shown, and the one a translation of it is of (itself when it is not a translation)
  private var shownVersion: (Version, VersionID)? {
    guard case .entry(_, let id)? = target, let v = entry?.versions.first(where: { $0.id == id }) else { return nil }
    return (v, v.of ?? v.id)
  }

  /// What the versions bar shows now; nil: no bar (a plain PDF with one version, a file alone)
  var versionsShown: VersionsShown? {
    guard let entry, let (v, original) = shownVersion, entry.versions.count > 1 || arxivID != nil else { return nil }
    let queue = context.pane.translations
    let job = queue?.job(entry.id, original)?.1
    var offer: VersionsShown.Offer?
    if arxivID != nil, let queue, job == nil, v.of == nil, !entry.versions.contains(where: { $0.of == v.id }) {
      offer = queue.missing.map { .no($0) } ?? .yes
    }
    let segments = entry.versions.enumerated().map { i, v in
      VersionsShown.Segment(id: v.id, label: v.label ?? "v\(i + 1)")
    }
    return VersionsShown(segments: segments, shown: v.id, translate: offer, job: job)
  }

  /// The bar follows the entry and its translation; the note goes when what it spoke of did
  func refreshVersions() {
    guard let s = versionsShown else {
      versions.isHidden = true
      note.isHidden = true
      return
    }
    versions.show(s)
    versions.isHidden = false
    placeVersions()
  }

  /// At the bottom middle, `look.bottom` above the tab's bottom edge as the board toolbar is above its panel's; the
  /// note above it
  func placeVersions() {
    let look = versions.look
    let size = versions.size
    versions.frame = CGRect(
      x: ((bounds.width - size.width) / 2).rounded(), y: bounds.height - look.bottom - size.height, width: size.width,
      height: size.height)
    note.setFrameOrigin(
      CGPoint(x: ((bounds.width - note.frame.width) / 2).rounded(), y: versions.frame.minY - 8 - note.frame.height))
  }

  func showNote(_ message: String, action: (title: String, id: String, run: () -> Void)? = nil) {
    note.show(message, action: action, look: versions.look)
    note.isHidden = false
    placeVersions()
  }

  /// Another version of the entry shown in this tab, which follows it (its payload and key: a relaunch reopens it);
  /// between a translation and what it translates the same page index stays in view
  func showVersion(_ id: VersionID) {
    guard case .entry(let e, let was)? = target, was != id, let entry else { return }
    let pair = entry.versions.contains { ($0.id == id && $0.of == was) || ($0.id == was && $0.of == id) }
    let page = pdf.currentPage.flatMap { pdf.document?.index(for: $0) }
    dismiss()
    note.isHidden = true
    let to = PDFTarget.entry(e, version: id)
    retarget(to)
    context.update(payload: to.payload, key: to.key)
    load()
    if pair, let page, let doc = pdf.document, doc.pageCount > 0, let p = doc.page(at: min(page, doc.pageCount - 1)) {
      pdf.go(to: p)
    }
    refreshVersions()
  }

  /// "+ 译文": the version shown queued for translation
  func translateShown() {
    guard let entry, let (v, _) = shownVersion, let vault = context.pane.vault,
      let job = TranslationJob(vault: vault, entry: entry, version: v)
    else { return }
    context.pane.translations?.add(job)
  }

  /// The job's item pressed: why it failed and Retry, or how it is going and Cancel
  func jobPressed() {
    guard let entry, let (_, original) = shownVersion, let queue = context.pane.translations,
      let (job, state) = queue.job(entry.id, original)
    else { return }
    if !note.isHidden {
      note.isHidden = true
      return
    }
    switch state {
    case .failed(let why):
      showNote(
        why,
        action: (
          "Retry", "ui-versionretry",
          { [weak self] in
            self?.note.isHidden = true
            queue.retry(job)
          }
        ))
    case .waiting, .running:
      showNote(
        VersionsBar.jobTitle(state),
        action: (
          "Cancel", "ui-versioncancel",
          { [weak self] in
            self?.note.isHidden = true
            queue.cancel(job)
          }
        ))
    }
  }

  /// ⋯'s menu
  func versionsMenu() -> NSMenu {
    let m = NSMenu()
    let item = NSMenuItem(
      title: "Check for New Version", action: #selector(checkForNewVersionChosen), keyEquivalent: "")
    item.target = self
    item.isEnabled = arxivID != nil
    m.autoenablesItems = false
    m.addItem(item)
    return m
  }

  @objc func checkForNewVersionChosen() { checkForNewVersion() }

  /// A newer version on arXiv added as one more version of the entry (none is added by itself); what it found said
  /// in the note. Its task, for tests
  @discardableResult func checkForNewVersion() -> Task<Void, Never>? {
    guard let entry, let path = entryPath, let vault = context.pane.vault else { return nil }
    let arxiv = context.pane.arxiv
    let held = entry.versions.filter { $0.of == nil }.compactMap(Arxiv.number).max()
    return Task { [weak self] in
      do {
        let added = try await arxiv.addLatestVersion(to: EntryIndex.Found(entry: entry, path: path), in: vault)
        guard let self else { return }
        if let added {
          self.reread()
          self.showNote("Added \(added.label ?? "a new version") from arXiv.")
        } else {
          self.showNote(held.map { "v\($0) is the newest version on arXiv." } ?? "Nothing newer on arXiv.")
        }
      } catch {
        self?.showNote("\(error)")
      }
    }
  }

  /// The entry read again from its file (a version added, a translation finished), and drawn when it changed
  func reread() {
    guard let path = entryPath, let e = try? context.pane.vault?.entry(at: path), e.id == entry?.id, e != entry else {
      return refreshVersions()
    }
    took(e, at: path)
  }
}
