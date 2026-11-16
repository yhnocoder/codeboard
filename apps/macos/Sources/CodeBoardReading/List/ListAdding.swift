import AppKit
import CodeBoardModel
import CodeBoardResources
import UniformTypeIdentifiers
import os

/// What dropping, pasting or choosing would add to a resource, by its preset; nil when the preset takes none of it,
/// and then nothing is added at all. Papers take PDFs and a paper by its arXiv id or address or its DOI, web pages take
/// addresses, files take any file; no preset takes a folder
enum ListAdd: Equatable {
  /// Copied in, each an entry alone under its own name (papers: a paper entry, ReadingPane.addPapers)
  case files([URL])
  /// Each a link entry, as the web bar saves a link
  case links([URL])
  /// A new entry from arXiv or doi.org (ReadingPane.addPaper)
  case paper(PaperID)

  static func files(_ urls: [URL], for preset: ResourcePreset) -> ListAdd? {
    guard !urls.isEmpty, preset != .web else { return nil }
    for u in urls {
      let values = try? u.resourceValues(forKeys: [.isRegularFileKey, .contentTypeKey])
      guard values?.isRegularFile == true else { return nil }
      if preset == .papers, values?.contentType?.conforms(to: .pdf) != true { return nil }
    }
    return .files(urls)
  }

  /// From a pasteboard: its files, else the address or arXiv paper its text (or its link) names
  static func reading(_ pb: NSPasteboard, for preset: ResourcePreset) -> ListAdd? {
    let files = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
    if !files.isEmpty { return Self.files(files, for: preset) }
    let link = (pb.readObjects(forClasses: [NSURL.self]) as? [URL])?.first?.absoluteString
    guard let text = pb.string(forType: .string) ?? link else { return nil }
    switch preset {
    case .web:
      let lines = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
      let urls = lines.compactMap(WebAddress.url(from:))
      return !urls.isEmpty && urls.count == lines.count ? .links(urls) : nil
    case .papers:
      return PaperID.parse(text).map(ListAdd.paper)
    case .files, .images, .blank:
      return nil
    }
  }
}

extension ListTabView {
  private static let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.yhnocoder.codeboard", category: "list")

  /// The empty list's one line: how things get into this preset's list
  static func emptyText(_ preset: ResourcePreset?) -> String {
    switch preset {
    case .papers?: "Drop PDFs here or paste an arXiv address or DOI"
    case .web?: "Paste or drop an address here"
    case .files?, .images?, .blank?, nil: "Drop files here or add them with +"
    }
  }

  /// What the + button's panel offers: PDFs for papers, any file for files (web pages take no file: no button)
  static func openPanel(_ preset: ResourcePreset, in window: NSWindow?) async -> [URL] {
    let p = NSOpenPanel()
    p.allowsMultipleSelection = true
    p.canChooseDirectories = false
    p.prompt = "Add"
    if preset == .papers { p.allowedContentTypes = [.pdf] }
    let answer = if let window { await p.beginSheetModal(for: window) } else { p.runModal() }
    return answer == .OK ? p.urls : []
  }

  // MARK: Paste, drop, +

  /// ⌘V with the list focused: what the pane's pasteboard holds, added; a beep when the preset takes none of it
  @objc func paste(_ sender: Any?) {
    guard let plan = preset.flatMap({ ListAdd.reading(context.pane.pasteboard, for: $0) }) else {
      return NSSound.beep()
    }
    add(plan)
  }

  @objc func pressedAdd() {
    guard let preset else { return }
    choosing = Task { [weak self] in
      guard let self else { return }
      let urls = await choose(preset, window)
      if urls.isEmpty { return }
      guard let plan = ListAdd.files(urls, for: preset) else { return NSSound.beep() }
      add(plan)
    }
  }

  override func draggingEntered(_ info: NSDraggingInfo) -> NSDragOperation { dropOperation(info) }

  override func draggingUpdated(_ info: NSDraggingInfo) -> NSDragOperation { dropOperation(info) }

  override func draggingExited(_ info: NSDraggingInfo?) { dropRing.isHidden = true }

  override func draggingEnded(_ info: NSDraggingInfo) { dropRing.isHidden = true }

  /// What a drop would add; nil for a row dragged out of this list, which is not added to it again
  private func dropped(_ info: NSDraggingInfo) -> ListAdd? {
    guard (info.draggingSource as AnyObject?) !== table else { return nil }
    return preset.flatMap { ListAdd.reading(info.draggingPasteboard, for: $0) }
  }

  private func dropOperation(_ info: NSDraggingInfo) -> NSDragOperation {
    let ok = dropped(info) != nil
    dropRing.isHidden = !ok
    return ok ? .copy : []
  }

  override func performDragOperation(_ info: NSDraggingInfo) -> Bool {
    dropRing.isHidden = true
    guard let plan = dropped(info) else { return false }
    add(plan)
    window?.makeFirstResponder(table)
    return true
  }

  // MARK: Adding

  /// `plan` added to the resource, all of it or (a file that cannot be copied) none, then the list read again with the
  /// first one added selected; an arXiv paper comes in the background, said on the bar while it does
  func add(_ plan: ListAdd) {
    guard let vault = context.pane.vault, let r = ListReading.resource(context.payload, in: vault).0 else { return }
    say(nil)
    switch plan {
    case .files(let urls):
      var added: [String] = []
      do {
        if r.preset == .papers {
          added = try context.pane.addPapers(pdfs: urls, to: r).map(\.found.path)
        } else {
          for u in urls { added.append(try vault.addFile(u, to: r.path)) }
        }
      } catch {
        // the copies made so far go again: a drop adds all or nothing
        for p in added { try? FileManager.default.removeItem(at: vault.url(of: p)) }
        return failed("The files could not be added: \(error)")
      }
      reveal(added.first)
    case .links(let urls):
      var first: String?
      do {
        for u in urls {
          let item = SavedItem(
            id: "", kind: .link, url: u.absoluteString, title: WebAddress.withPath(u), savedAt: Int64(Entry.now))
          let path = try vault.save(item, in: r.path)
          context.pane.entries.update(try vault.entry(at: path), at: path)
          first = first ?? path
        }
      } catch {
        failed("The address could not be added: \(error)")
      }
      reveal(first)
    case .paper(let id):
      if let found = context.pane.paper(id) {
        guard found.path.hasPrefix(r.path + "/") else {
          let home = found.path.split(separator: "/").dropLast().last.map { ($0 as NSString).deletingPathExtension }
          return failed("“\(found.entry.title)” is already in \(home ?? "another resource")")
        }
        return reveal(found.path)
      }
      say("Adding \(id)…")
      let pane = context.pane
      adding = Task { [weak self] in
        do {
          let path = try await pane.addPaper(id, to: r).found.path
          guard let self else { return }
          say(nil)
          reveal(path)
        } catch let e as ArxivError {
          self?.failed(e.description)
        } catch let e as DOIError {
          self?.failed(e.description)
        } catch {
          self?.failed("The paper could not be added: \(error)")
        }
      }
    }
  }

  /// The list read again, the row at `path` selected and shown (the filter cleared when it hides it)
  private func reveal(_ path: String?) {
    let (r, tree) = ListReading.resource(context.payload, in: context.pane.vault)
    show(r, tree: tree)
    guard let path else { return }
    if !shown.contains(where: { $0.key == path }), !search.stringValue.isEmpty {
      search.stringValue = ""
      filterChanged()
    }
    if let i = shown.firstIndex(where: { $0.key == path }) { select(i) }
  }

  func failed(_ why: String) {
    Self.log.error("\(why, privacy: .public)")
    NSSound.beep()
    say(why)
  }

  /// What the bar says of an add going on or failed; nil: nothing
  func say(_ text: String?) {
    note.stringValue = text ?? ""
    note.toolTip = text
  }
}

/// The ring a list shows while a drop it takes is held over it: the theme's accent, a faint wash of it inside
final class ListDropRing: NSView {
  var accent = NSColor.controlAccentColor
  var radius: CGFloat = 8

  override func draw(_ dirtyRect: NSRect) {
    let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.75, dy: 0.75), xRadius: radius, yRadius: radius)
    accent.withAlphaComponent(0.06).setFill()
    path.fill()
    path.lineWidth = 1.5
    accent.setStroke()
    path.stroke()
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
