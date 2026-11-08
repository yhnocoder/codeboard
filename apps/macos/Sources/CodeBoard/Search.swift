// ⌘K across every board, through box, the index service the VS Code extension uses too (BoxService.swift), fed exactly as
// the host's Related by Meaning feeds it (packages/host/src/meaning.ts): per storage folder (the source) at its git branch
// (the ref), every card and sidenote as an item whose groups are the boards it is on, pictures under the same keys (core's
// projectDocs through js/library.ts), so the app and VS Code share one index. Keyword hits need no model; by meaning and the
// reranker need the embedding server (codeboard.search.*), and without it ⌘K quietly stays keyword-only until it answers.
import AppKit
import SwiftUI

/** Where a document came from (core's SearchItem origin, js/library.ts LibDoc) */
struct DocOrigin: Decodable {
  var kind: String
  var label: String
  var board: String
  var card: String
  var boards: [String]
  var `where`: String?
}
struct LibDoc: Decodable {
  var id: String
  var title: String
  var text: String
  var groups: [String]
  var images: [Image]?
  var origin: DocOrigin
  struct Image: Codable {
    var key: String
    var url: String?
  }
  /** As a sync item (PROTOCOL.md) */
  var item: [String: Any] {
    var o: [String: Any] = ["id": id, "title": title, "text": text, "groups": groups]
    if let images { o["images"] = images.map { i -> [String: Any] in i.url.map { ["key": i.key, "url": $0] } ?? ["key": i.key] } }
    return o
  }
}

/** One row of ⌘K */
struct SearchHit: Identifiable, Hashable {
  enum Kind { case board, card, related }
  var kind: Kind
  var dir: String
  var board: String
  var card: String?
  var title: String
  var detail: String
  var snippet: String = ""
  var score: Double = 0
  var faint = false
  var id: String { "\(kind)|\(dir)|\(board)|\(card ?? "")" }
}

/** Related by Meaning's tuning, the host's (meaningdocs.ts: MIN_SCORE, FAINT_BELOW, REINDEX_PAUSE, TOP) */
struct Tuning: Decodable {
  var minScore = 0.55, faintBelow = 0.635, reindexPause = 3000.0
  var top = 8
}

/** What a search needs of one folder, copied off the main thread */
private struct Source {
  var ref = "_"
  var docs: [String: LibDoc] = [:]
  var synced = false
  var started: Double = 0
}

@MainActor
final class SearchIndex: ObservableObject {
  /** A quiet line on what search can do now: keyword only, indexing, by meaning */
  @Published var status = "Keyword search"
  /** The embedding server answered the last probe */
  @Published private(set) var semantic = false
  private(set) var hasReranker = false
  /** Seconds from a folder's first sync to box having embedded everything in it (the checks' number) */
  private(set) var indexedIn: [String: Double] = [:]
  let tune: Tuning

  private let lib: JSBridge
  private let box: BoxService?
  private var sources: [String: Source] = [:]
  private var timers: [String: Timer] = [:]
  private var polls: [String: Timer] = [:]
  /** Picture keys box has indexed per folder, for the current endpoint: later syncs hand them without their data (as the
   *  host's MeaningSearch.pictured, in memory) */
  private var pictured: [String: Set<String>] = [:]
  private var picturedFor = ""
  private var handed: [String: Set<String>] = [:]
  private var running = Set<String>(), again = Set<String>()

  init(lib: JSBridge, boxBin: String?, tune: Tuning) {
    self.lib = lib
    self.tune = tune
    if let b = boxBin, FileManager.default.isExecutableFile(atPath: b) { box = BoxService(bin: b) } else {
      box = nil
      status = "Search is off: this build has no box"
    }
    NotificationCenter.default.addObserver(forName: .codeboardSettings, object: nil, queue: .main) { [weak self] n in
      guard let k = n.object as? String, k.hasPrefix("search.") else { return }
      MainActor.assumeIsolated { self?.settingsChanged() }
    }
  }
  private func settingsChanged() {
    probe { [weak self] _ in
      guard let self else { return }
      for d in self.sources.keys { self.soon(d, after: 0.2) }
    }
  }

  func embedder() -> Embedder {
    let m = AppSettings.string("search.embeddingModel")
    return Embedder(base: AppSettings.string("search.embeddingUrl"), model: m.isEmpty ? nil : m, key: AppSettings.embeddingKey)
  }
  private var conf: String { let e = embedder(); return "\(e.base)|\(e.model ?? "")|\(e.key ?? "")" }

  // MARK: the embedding server
  private var probedAt = 0.0
  /** Asks the server for its models (2 s at most): sets semantic, hasReranker and the status line */
  func probe(force: Bool = true, _ done: ((Bool) -> Void)? = nil) {
    let e = embedder()
    if !force && CACurrentMediaTime() - probedAt < 10 { done?(semantic); return }
    guard box != nil else { done?(false); return }
    guard !e.base.isEmpty, let u = URL(string: e.base.hasSuffix("/") ? "\(e.base)models" : "\(e.base)/models") else {
      setSemantic(false, "Keyword search (set an embedding server in Settings to search by meaning)")
      done?(false)
      return
    }
    var r = URLRequest(url: u, timeoutInterval: 2)
    if let k = e.key { r.setValue("Bearer \(k)", forHTTPHeaderField: "Authorization") }
    let rerankModel = AppSettings.string("search.rerankModel")
    URLSession.shared.dataTask(with: r) { data, resp, err in
      let ok = (resp as? HTTPURLResponse)?.statusCode == 200
      let ids = ((data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["data"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
      let why = err?.localizedDescription ?? "HTTP \((resp as? HTTPURLResponse)?.statusCode ?? 0)"
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self.probedAt = CACurrentMediaTime()
          let was = self.semantic
          self.hasReranker = ids.contains { $0.contains("rerank") } || !rerankModel.isEmpty
          self.setSemantic(ok, ok ? "Search by meaning: \(e.model ?? ids.first { $0.contains("embed") } ?? "on")" : "Keyword search: the embedding server isn't answering (\(why))")
          // the server is back: hand box the folders again so it embeds now, not at its next retry
          if ok && !was { for d in self.sources.keys { self.soon(d, after: 0) } }
          done?(ok)
        }
      }
    }.resume()
  }
  private func setSemantic(_ on: Bool, _ line: String) {
    semantic = on
    status = line
  }

  // MARK: indexing
  /** A folder's boards changed (or were first listed): index them a little later */
  func soon(_ dir: String, after: Double? = nil) {
    guard box != nil else { return }
    timers[dir]?.invalidate()
    let t = Timer(timeInterval: after ?? tune.reindexPause / 1000, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.index(dir) }
    }
    t.tolerance = 0.5
    RunLoop.main.add(t, forMode: .common)
    timers[dir] = t
  }
  /** The folder left the library: its manifest goes from box, its timers stop */
  func forget(_ dir: String) {
    timers.removeValue(forKey: dir)?.invalidate()
    polls.removeValue(forKey: dir)?.invalidate()
    sources[dir] = nil
    pictured[dir] = nil
    handed[dir] = nil
    guard let box else { return }
    Task.detached { try? await box.forget(source: dir) }
  }

  private func index(_ dir: String) {
    guard let box else { return }
    if running.contains(dir) { again.insert(dir); return }
    running.insert(dir)
    if sources[dir] == nil { sources[dir] = Source(started: CACurrentMediaTime()) }
    if conf != picturedFor {
      picturedFor = conf
      pictured = [:]
    }
    let t0 = CACurrentMediaTime()
    let skip = Array(pictured[dir] ?? [])
    lib.lib("docs", [dir, encodeJSON(skip)], [LibDoc].self) { [weak self] r in
      MainActor.assumeIsolated {
        guard let self else { return }
        guard case .success(let docs) = r else {
          logLine("[codeboard search] docs %@: %@", dir, "\(r)")
          return self.finish(dir)
        }
        let tDocs = CACurrentMediaTime() - t0
        let e = self.embedder()
        let handed = Set(docs.flatMap { $0.images ?? [] }.filter { $0.url != nil }.map(\.key))
        let items = docs.map(\.item)
        Task.detached {
          let ref = gitRef(dir)
          do {
            try await box.sync(source: dir, ref: ref, embedder: e, items: items)
            await MainActor.run {
              logLine("[codeboard search] synced %@ @ %@: %d items, %d pictures with data (docs %.0f ms)", dir, ref, items.count, handed.count, tDocs * 1000)
              guard self.sources[dir] != nil else { return self.finish(dir) }  // forgotten meanwhile
              self.sources[dir]?.ref = ref
              self.sources[dir]?.docs = Dictionary(docs.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
              self.sources[dir]?.synced = true
              self.handed[dir] = handed
              self.watchStatus(dir)
              self.finish(dir)
            }
          } catch {
            await MainActor.run {
              logLine("[codeboard search] sync %@: %@", dir, "\(error)")
              self.status = "Search is off: \(error.localizedDescription)"
              self.finish(dir)
            }
          }
        }
      }
    }
  }
  private func finish(_ dir: String) {
    running.remove(dir)
    if again.remove(dir) != nil { index(dir) }
  }

  /** While box embeds a folder: its progress in the status line every 2 s, until it is done; none while the server is not
   *  answering (box retries on its own) */
  private func watchStatus(_ dir: String) {
    polls[dir]?.invalidate()
    guard semantic, let box, let ref = sources[dir]?.ref else { return }
    let t = Timer(timeInterval: 2, repeats: true) { [weak self] t in
      Task { @MainActor in
        guard let self, self.sources[dir] != nil else { t.invalidate(); return }
        guard let st = try? await box.status(source: dir, ref: ref) else { return }
        if st.error != nil || !self.semantic { t.invalidate(); return }
        if st.indexing || st.left > 0 {
          self.status = "Indexing by meaning: \(st.left) left"
          return
        }
        t.invalidate()
        self.pictured[dir, default: []].formUnion(self.handed[dir] ?? [])
        self.handed[dir] = []
        if self.indexedIn[dir] == nil, let s = self.sources[dir] {
          self.indexedIn[dir] = CACurrentMediaTime() - s.started
          logLine("[codeboard search] %@ indexed by meaning in %.1f s (%d items, %d pieces)", dir, self.indexedIn[dir]!, st.items, st.pieces)
        }
        self.status = "Search by meaning: \(st.model ?? "on")"
      }
    }
    t.tolerance = 0.5
    RunLoop.main.add(t, forMode: .common)
    polls[dir] = t
  }

  // MARK: searching
  /** The folders synced so far, as values a search can take off the main thread */
  fileprivate var ready: [(String, Source)] { sources.filter(\.value.synced).map { ($0.key, $0.value) } }
  /** Folders handed to box so far (keyword search covers them) */
  var syncedCount: Int { sources.values.filter(\.synced).count }

  /** Keyword hits over every folder, best first */
  func keyword(_ q: String, names: @escaping @Sendable (String, String) -> String) async -> [SearchHit] {
    guard let box else { return [] }
    let srcs = ready, top = tune.top
    return await Task.detached {
      var all: [SearchHit] = []
      await withTaskGroup(of: [SearchHit].self) { g in
        for (dir, s) in srcs {
          g.addTask {
            guard let r = try? await box.search("search_keyword", source: dir, ref: s.ref, q: q, k: top) else { return [] }
            return r.hits.compactMap { h in s.docs[h.id].map { hit(.card, dir, $0, h.score, h.range, names) } }
          }
        }
        for await hs in g { all += hs }
      }
      return Array(all.sorted { $0.score > $1.score }.prefix(top))
    }.value
  }

  /** By meaning over every folder (MIN_SCORE and up), or read again by the reranker */
  func related(_ q: String, rerank: Bool, names: @escaping @Sendable (String, String) -> String) async -> [SearchHit] {
    guard let box, semantic else { return [] }
    let srcs = ready, t = tune
    let rm = AppSettings.string("search.rerankModel")
    return await Task.detached {
      var all: [SearchHit] = []
      await withTaskGroup(of: [SearchHit].self) { g in
        for (dir, s) in srcs {
          g.addTask {
            guard let r = try? await box.search(rerank ? "rerank" : "search", source: dir, ref: s.ref, q: q, k: t.top * 2, minScore: t.minScore, model: rerank && !rm.isEmpty ? rm : nil),
              r.superseded != true
            else { return [] }
            // reranked: box's fused order, kept across folders by place; by meaning: the score
            return r.hits.enumerated().compactMap { i, h in
              guard let d = s.docs[h.id] else { return nil }
              var x = hit(.related, dir, d, rerank ? 1 - Double(i) / 100 + h.score / 1000 : h.score, (h.piece ?? 0) > 0 ? h.range : nil, names)
              x.faint = h.score < t.faintBelow
              return x
            }
          }
        }
        for await hs in g { all += hs }
      }
      return Array(all.sorted { $0.score > $1.score }.prefix(t.top))
    }.value
  }
}

private func hit(_ k: SearchHit.Kind, _ dir: String, _ d: LibDoc, _ score: Double, _ range: [Int]?, _ names: (String, String) -> String) -> SearchHit {
  let text = d.text as NSString
  var snippet = ""
  if let r = range, r.count == 2, r[0] < text.length {
    let a = max(0, r[0] - 40), b = min(text.length, max(r[1], r[0]) + 80)
    snippet = (a > 0 ? "…" : "") + text.substring(with: NSRange(location: a, length: b - a)).replacingOccurrences(of: "\n", with: " ")
  } else {
    snippet = String(d.text.prefix(120)).replacingOccurrences(of: "\n", with: " ")
  }
  return SearchHit(kind: k, dir: dir, board: d.origin.board, card: d.origin.card, title: d.origin.label.isEmpty ? d.title : d.origin.label,
                   detail: (d.origin.where ?? "").isEmpty ? names(dir, d.origin.board) : d.origin.where!, snippet: snippet, score: score)
}

/** The storage folder's git branch (detached: the commit), "_" outside git (meaning.ts refOf: the same ref, so the same
 *  manifest in box) */
func gitRef(_ dir: String) -> String {
  func git(_ args: [String]) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    p.arguments = ["-C", dir] + args
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return nil }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { return nil }
    return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  }
  guard let b = git(["rev-parse", "--abbrev-ref", "HEAD"]), !b.isEmpty else { return "_" }
  if b != "HEAD" { return b }
  return git(["rev-parse", "HEAD"]).map { "detached:\($0)" } ?? "_"
}

// MARK: the panel

@MainActor
final class SearchModel: ObservableObject {
  @Published var query = "" { didSet { if query != oldValue { run() } } }
  @Published private(set) var boards: [SearchHit] = []
  @Published private(set) var cards: [SearchHit] = []
  @Published private(set) var related: [SearchHit] = []
  @Published var selected = 0
  @Published private(set) var busy = false
  let index: SearchIndex
  /** Every board the library lists (dir, meta), its project's name */
  var allBoards: () -> [(dir: String, project: String, id: String, name: String)] = { [] }
  var open: (SearchHit) -> Void = { _ in }
  /** ms from typing to keyword rows and to rows by meaning (the checks') */
  private(set) var keywordMs: Double = 0, relatedMs: Double = 0
  var onRelated: (() -> Void)?
  /** The query being answered; a newer one cancels it */
  private var task: Task<Void, Never>?

  init(index: SearchIndex) { self.index = index }

  var rows: [SearchHit] { boards + cards + related }

  private func run() {
    task?.cancel()
    let q = query.trimmingCharacters(in: .whitespaces)
    selected = 0
    guard !q.isEmpty else { boards = []; cards = []; related = []; busy = false; return }
    let t0 = CACurrentMediaTime()
    let all = allBoards()
    boards = Array(all.filter { $0.name.localizedCaseInsensitiveContains(q) }.prefix(5)).map {
      SearchHit(kind: .board, dir: $0.dir, board: $0.id, title: $0.name, detail: $0.project)
    }
    let nameMap = Dictionary(all.map { ("\($0.dir)|\($0.id)", "\($0.name) — \($0.project)") }, uniquingKeysWith: { a, _ in a })
    let names: @Sendable (String, String) -> String = { d, b in nameMap["\(d)|\(b)"] ?? b }
    busy = true
    let rerank = AppSettings.bool("search.rerank")
    task = Task {
      // a few ms of typing in a row make one query
      try? await Task.sleep(nanoseconds: 60_000_000)
      if Task.isCancelled { return }
      let kw = await index.keyword(q, names: names)
      if Task.isCancelled { return }
      cards = kw
      keywordMs = (CACurrentMediaTime() - t0) * 1000
      guard index.semantic else { related = []; busy = false; return }
      let seen = Set(kw.map { "\($0.dir)|\($0.card ?? "")" })
      // by meaning first, then the reranker's order when it answers
      let rel = await index.related(q, rerank: false, names: names)
      if Task.isCancelled { return }
      related = rel.filter { !seen.contains("\($0.dir)|\($0.card ?? "")") }
      relatedMs = (CACurrentMediaTime() - t0) * 1000
      logLine("[codeboard search] %@: keyword %.0f ms (%d), by meaning %.0f ms (%d)", q, keywordMs, kw.count, relatedMs, rel.count)
      guard rerank, index.hasReranker, !rel.isEmpty else { busy = false; onRelated?(); return }
      let rr = await index.related(q, rerank: true, names: names)
      if Task.isCancelled { return }
      if !rr.isEmpty {
        withAnimation(.snappy) { related = rr.filter { !seen.contains("\($0.dir)|\($0.card ?? "")") } }
        logLine("[codeboard search] %@: reranked %.0f ms", q, (CACurrentMediaTime() - t0) * 1000)
      }
      busy = false
      onRelated?()
    }
  }

  func move(_ d: Int) {
    let n = rows.count
    guard n > 0 else { return }
    selected = (selected + d + n) % n
  }
  func enter() {
    let r = rows
    if selected < r.count { open(r[selected]) }
  }
}

struct SearchView: View {
  @ObservedObject var m: SearchModel
  @ObservedObject var index: SearchIndex
  var close: () -> Void
  @ObservedObject private var look = Look.shared
  @FocusState private var focused: Bool

  var body: some View {
    let ch = look.chrome
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        Image(systemName: "magnifyingglass").font(.system(size: 20, weight: .medium)).foregroundStyle(.secondary)
        TextField("Search All Boards", text: $m.query)
          .textFieldStyle(.plain)
          .font(Design.panelFieldFont)
          .focused($focused)
          .onKeyPress(.downArrow) { m.move(1); return .handled }
          .onKeyPress(.upArrow) { m.move(-1); return .handled }
          .onKeyPress(.return) { m.enter(); return .handled }
          .onKeyPress(.escape) { close(); return .handled }
        if m.busy { ProgressView().controlSize(.small) }
      }
      .padding(.horizontal, 20)
      .frame(height: Design.panelFieldHeight)
      if !m.rows.isEmpty {
        Divider().opacity(0.4)
        ScrollViewReader { sv in
          ScrollView {
            VStack(alignment: .leading, spacing: 1) {
              group("Boards", m.boards, from: 0)
              group("Cards", m.cards, from: m.boards.count)
              group("Related by Meaning", m.related, from: m.boards.count + m.cards.count)
            }
            .padding(8)
          }
          .onChange(of: m.selected) { _, s in sv.scrollTo(s) }
        }
        .frame(maxHeight: Design.panelMaxList)
        .fixedSize(horizontal: false, vertical: true)
      }
      if !m.query.isEmpty {
        Divider().opacity(0.4)
        HStack {
          Text(index.status).lineLimit(1)
          Spacer()
          Text("↑↓ choose   ↩ open   esc close")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
      }
    }
    .frame(width: Design.panelWidth)
    .background(RoundedRectangle(cornerRadius: Design.panelRadius).fill(ch.panel.color))
    .modifier(PanelSurface(glass: ch.glass, hair: ch.hair.color))
    .tint(ch.accent.color)
    .onAppear { focused = true }
  }

  @ViewBuilder
  private func group(_ title: String, _ hits: [SearchHit], from: Int) -> some View {
    if !hits.isEmpty {
      Text(title).font(Design.panelGroupFont).foregroundStyle(.secondary).padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 3)
      ForEach(Array(hits.enumerated()), id: \.element.id) { i, h in
        row(h, selected: m.selected == from + i)
          .id(from + i)
          .contentShape(Rectangle())
          .onTapGesture { m.selected = from + i; m.enter() }
      }
    }
  }

  /** The query's words in bold, the rest as it is */
  private func marked(_ s: String) -> AttributedString {
    var a = AttributedString(s)
    for w in m.query.split(separator: " ") where w.count > 1 {
      var from = a.startIndex
      while let r = a[from...].range(of: String(w), options: .caseInsensitive) {
        a[r].font = .system(size: 12, weight: .bold)
        a[r].foregroundColor = .primary
        from = r.upperBound
      }
    }
    return a
  }

  private func row(_ h: SearchHit, selected: Bool) -> some View {
    let ch = look.chrome
    return HStack(spacing: 10) {
      Image(systemName: h.kind == .board ? "rectangle.on.rectangle" : h.kind == .card ? "doc.text" : "sparkles")
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(ch.accent.color)
        .frame(width: Design.rowIcon, height: Design.rowIcon)
        .background(RoundedRectangle(cornerRadius: 7).fill(ch.tint.color))
      VStack(alignment: .leading, spacing: 2) {
        Text(h.title).font(Design.rowTitleFont).lineLimit(1)
        Text(h.snippet.isEmpty ? AttributedString(h.detail) : marked(h.snippet)).font(Design.rowDetailFont).lineLimit(1)
          .foregroundStyle(.secondary)
      }
      Spacer(minLength: 8)
      if !h.snippet.isEmpty {
        Text(h.detail).font(.caption).lineLimit(1).truncationMode(.middle).frame(maxWidth: 180, alignment: .trailing)
          .foregroundStyle(.secondary)
      }
    }
    .opacity(h.faint && !selected ? Design.faint : 1)
    .padding(.horizontal, 8)
    .frame(height: Design.rowHeight)
    .background(RoundedRectangle(cornerRadius: Design.rowRadius).fill(selected ? ch.tint.color : .clear))
    .animation(.easeOut(duration: 0.12), value: selected)
  }
}

/** ⌘K's surface: glass in a glass look, a solid panel with a hairline and a shadow otherwise */
private struct PanelSurface: ViewModifier {
  var glass: Bool
  var hair: Color
  func body(content: Content) -> some View {
    if glass {
      content.glassEffect(Look.current.swiftUIGlass, in: .rect(cornerRadius: Design.panelRadius))
    } else {
      content
        .overlay(RoundedRectangle(cornerRadius: Design.panelRadius).strokeBorder(hair, lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: Design.panelRadius))
        .shadow(color: .black.opacity(0.18), radius: 24, y: 10)
    }
  }
}

/** A floating panel like Spotlight's: becomes key to take the typing, goes when it loses it */
final class SearchPanel: NSPanel {
  let model: SearchModel
  init(model: SearchModel) {
    self.model = model
    super.init(contentRect: NSRect(x: 0, y: 0, width: Design.panelWidth, height: Design.panelFieldHeight), styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView], backing: .buffered, defer: false)
    isFloatingPanel = true
    level = .floating
    backgroundColor = .clear
    isOpaque = false
    hasShadow = true
    isMovableByWindowBackground = true
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    let host = NSHostingController(rootView: SearchView(m: model, index: model.index, close: { [weak self] in self?.orderOut(nil) }))
    host.sizingOptions = [.preferredContentSize]
    contentViewController = host
  }
  override var canBecomeKey: Bool { true }
  override func resignKey() {
    super.resignKey()
    orderOut(nil)
  }
  /** Shown near the top of the screen with the key window (or the main screen), the field ready */
  func show() {
    let screen = NSApp.keyWindow?.screen ?? NSScreen.main
    if let f = screen?.visibleFrame {
      setFrameTopLeftPoint(NSPoint(x: f.midX - Design.panelWidth / 2, y: f.maxY - f.height * 0.18))
    }
    model.index.probe(force: false)
    makeKeyAndOrderFront(nil)
  }
  // the hosting view grows with the rows: keep the top edge where it is
  override func setContentSize(_ size: NSSize) {
    let top = frame.maxY
    super.setContentSize(size)
    setFrameOrigin(NSPoint(x: frame.minX, y: top - frame.height))
  }
}
