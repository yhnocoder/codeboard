import AppKit
import CodeBoardModel
import CodeBoardResources
import WebKit

/// A web page filling its tab, with its bar floating over the page's bottom edge. The bar comes and goes as
/// `WebBarVisibility` says, moving over the page: the page is never laid out again for it. A saved page is shown in
/// the same view, under the app's own scheme with its scripts off, until the tab goes to an address, and translated
/// there block by block, its translations kept beside its entry. The tab follows what it shows (its title, what it
/// saves, how a saved page is shown), so that a session restored opens it again
final class WebPageView: NSView, NSTextFieldDelegate, WKNavigationDelegate, WKUIDelegate, ReadingLookFollower {
  let web: WKWebView
  let bar: WebBar
  let suggestions: WebSuggestions
  private let context: ReadingContext
  /// The saving service; none: links alone are saved, and a saved page is not on this Mac
  private let store: (any PageStore)?
  private(set) var visibility = WebBarVisibility()
  /// Where the bar is now, which lags `visibility` while it slides
  private var barShown = true
  private var observations: [NSKeyValueObservation] = []
  private var clearedObserver: (any NSObjectProtocol)?
  /// Opened blank: the address is edited as soon as the view is in a window
  private var editOnShow: Bool
  /// What was typed, back in the address when the arrows return to it from the suggestions
  private var typed = ""
  private(set) var history = WebHistory()
  private let scripts: WebScripts?
  /// The saving of this page whole under way
  private(set) var capture: WebCapture?
  /// How the page is saved, as the owner said when it loaded or as it was saved since
  private(set) var saved = WebReading.Saved.unsaved
  /// The address `saved` is for
  private var savedFor: URL?
  /// What the save button says now
  private(set) var saveState = WebBar.Save.off("")
  /// The saved pages this tab opened, by hash: what the bar shows for them and the tab is told
  private var savedPages: [String: (address: URL, title: String)] = [:]
  private let userScripts: WKUserContentController
  private let scroll: WKUserScript
  /// Whose scripts the page gets: saved pages' or online ones'; none before the first page
  private var scriptsForSaved: Bool?
  /// The next page is one the tab loads, not one a saved page starts loading by itself
  private var ownLoad = false
  /// Loads a saved page started by itself (a refresh, a redirect), refused
  private(set) var refused: [URL] = []
  /// Translates saved pages' blocks; none: they are not translated
  private let translator: WebReading.Translator?
  /// How a saved page is shown
  private(set) var language: WebReading.Language
  /// The saved page's blocks as its reader gives them, with its numbering and the page's language; none before the
  /// reader gave them
  private(set) var blocks: (scheme: Int, lang: String?, list: [WebBlock])?
  /// The reader was asked for the blocks and cannot give them
  private var readerLacksBlocks = false
  /// Where this saved page's translations are kept, and what they are now; none while its entry is not known
  private var kept: Kept?
  /// Why the kept translations could not be read: they are left as they are
  private var keptError: String?
  /// The translating under way
  private(set) var translating: Task<Void, Never>?
  /// Blocks translated of those asked for, while translating
  private var progress: (done: Int, of: Int)?
  /// Why the last translating left blocks out
  private var translationFailure: String?
  /// The translations' writes, each after the one before
  private var writing: Task<Void, Never>?
  /// The views of open web tabs
  private static var live: [ReadingTab.ID: Weak] = [:]
  private struct Weak {
    weak var view: WebPageView?
  }

  static func view(of tab: ReadingTab.ID) -> WebPageView? { live[tab]?.view }

  /// None when the shell gave the tab no folder of its own on this Mac: no history is kept
  private var historyFile: URL? { context.dataFolder?.appending(path: "history.json") }
  static let slide: TimeInterval = 0.18

  /// Scroll offsets, posted from the page's scroll events in a world of their own so that the page's scripts neither
  /// see nor fake them. WebKit sends scroll events once per frame at most, as the page is drawn, so the main thread
  /// hears of a scroll no more often than that, and nothing polls
  static let scrollScript = """
    addEventListener("scroll", () => webkit.messageHandlers.scroll.postMessage(scrollY), { passive: true })
    """

  /// `scripts`: the folder of the saving service's page scripts; `websiteData`: where its sites keep their data. A tab
  /// opened for a page's new window is handed the configuration WebKit made for it, which WebKit loads itself
  init(
    context: ReadingContext, store: (any PageStore)?, scripts: URL?, translate: WebReading.Translator?,
    websiteData: WKWebsiteDataStore
  ) {
    self.context = context
    self.store = store
    translator = translate
    language = context.payload["view"].flatMap(WebReading.Language.init) ?? .original
    let page = WebReading.Page(payload: context.payload)
    let handed = context.handed as? WKWebViewConfiguration
    // a new window's configuration is a copy of its opener's: its data store, which WebKit wants for both, and the
    // opener's scripts and scheme handler, which it gets its own of
    let config = handed ?? WKWebViewConfiguration()
    if handed == nil { config.websiteDataStore = websiteData }
    config.applicationNameForUserAgent = WebReading.applicationName
    config.userContentController = WKUserContentController()
    if config.urlSchemeHandler(forURLScheme: WebReading.savedScheme) == nil {
      config.setURLSchemeHandler(SavedPageHandler(store: store), forURLScheme: WebReading.savedScheme)
    }
    userScripts = config.userContentController
    let relay = ScrollRelay()
    userScripts.add(relay, contentWorld: .defaultClient, name: "scroll")
    scroll = WKUserScript(
      source: Self.scrollScript, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .defaultClient)
    self.scripts = WebScripts(scripts)
    let saving = SavingRelay()
    if self.scripts != nil {
      userScripts.addScriptMessageHandler(saving, contentWorld: WebReading.scriptWorld, name: "shiyi")
    }
    web = WKWebView(frame: .zero, configuration: config)
    bar = WebBar(look: context.bar)
    suggestions = WebSuggestions(look: context.bar)
    editOnShow = page == .online(nil) && handed == nil
    super.init(frame: .zero)
    setAccessibilityIdentifier("ui-web")
    relay.owner = self
    saving.owner = self
    web.allowsBackForwardNavigationGestures = true
    web.navigationDelegate = self
    web.uiDelegate = self
    web.autoresizingMask = [.width, .height]
    web.setAccessibilityIdentifier("ui-webpage")
    addSubview(web)
    suggestions.isHidden = true
    suggestions.onChoose = { [weak self] url in self?.go(to: url) }
    addSubview(suggestions)
    addSubview(bar)
    bar.back.target = self
    bar.back.action = #selector(goBack(_:))
    bar.forward.target = self
    bar.forward.action = #selector(goForward(_:))
    bar.save.target = self
    bar.save.action = #selector(saveClicked(_:))
    bar.extract.target = self
    bar.extract.action = #selector(extractChosen(_:))
    bar.translate.target = self
    bar.translate.action = #selector(translateChosen(_:))
    bar.translate.selectedSegment = WebReading.Language.allCases.firstIndex(of: language) ?? 0
    bar.address.delegate = self
    bar.address.onEdit = { [weak self] in self?.beginEditing() }
    observations = [
      web.observe(\.title) { [weak self] _, _ in
        MainActor.assumeIsolated {
          self?.pageChanged()
          self?.record(counted: false)
        }
      },
      web.observe(\.url) { [weak self] _, _ in MainActor.assumeIsolated { self?.pageChanged() } },
      web.observe(\.canGoBack) { [weak self] _, _ in MainActor.assumeIsolated { self?.historyChanged() } },
      web.observe(\.canGoForward) { [weak self] _, _ in MainActor.assumeIsolated { self?.historyChanged() } },
    ]
    clearedObserver = NotificationCenter.default.addObserver(
      forName: WebReading.siteDataCleared, object: websiteData, queue: .main
    ) { [weak self] note in
      let domain = note.userInfo?["domain"] as? String
      MainActor.assumeIsolated { self?.siteDataCleared(domain) }
    }
    Self.live[context.tab] = Weak(view: self)
    historyChanged()
    pageChanged()
    switch page {
    case .online(let url): if let url { load(url) }
    case .saved(let hash, let address, let title):
      savedPages[hash] = (address, title)
      load(WebReading.savedURL(hash))
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("WebPageView is not loaded from nibs") }

  isolated deinit {
    if let clearedObserver { NotificationCenter.default.removeObserver(clearedObserver) }
    translating?.cancel()
  }

  override var isFlipped: Bool { true }

  override func layout() {
    super.layout()
    web.frame = bounds
    bar.frame = barFrame(shown: barShown)
    let b = barFrame(shown: true)
    suggestions.frame = CGRect(
      x: b.minX, y: b.minY - 6 - suggestions.height, width: b.width, height: suggestions.height)
    suggestions.textX = WebBar.addressX(bar.look)
  }

  /// The board toolbar's height and distance from the bottom, so that beside the board the two bars' edges are on one
  /// line; as far from the sides as from the bottom
  private func barFrame(shown: Bool) -> CGRect {
    let look = bar.look
    let y = bounds.height - look.bottom - look.height
    return CGRect(
      x: look.bottom, y: shown ? y : bounds.height + look.radius, width: max(0, bounds.width - 2 * look.bottom),
      height: look.height)
  }

  func barLookChanged(_ look: ReadingBarLook) {
    bar.look = look
    suggestions.look = look
    needsLayout = true
  }

  /// Taken out of the pane: its tab closed
  override func viewDidMoveToSuperview() {
    super.viewDidMoveToSuperview()
    if superview == nil { translating?.cancel() }
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    guard window != nil, editOnShow else { return }
    editOnShow = false
    openLocation(nil)
  }

  // MARK: The bar coming and going

  func handle(_ event: WebBarVisibility.Event) {
    visibility.handle(event)
    guard visibility.shown != barShown else { return }
    barShown = visibility.shown
    bar.isHidden = false
    let to = barFrame(shown: barShown)
    let slide = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = Self.slide
      ctx.allowsImplicitAnimation = true
      bar.animator().alphaValue = barShown ? 1 : 0
      if slide { bar.animator().frame = to }
    } completionHandler: { [weak self] in
      MainActor.assumeIsolated {
        guard let self, !self.barShown else { return }
        self.bar.isHidden = true
        self.bar.frame = self.barFrame(shown: false)
      }
    }
    if !slide, barShown { bar.frame = to }
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for t in trackingAreas where t.owner === self { removeTrackingArea(t) }
    addTrackingArea(
      NSTrackingArea(
        rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
  }

  override func mouseMoved(with event: NSEvent) {
    handle(.pointer(bounds.height - convert(event.locationInWindow, from: nil).y))
  }
  override func mouseExited(with event: NSEvent) { handle(.pointer(nil)) }

  fileprivate func scrolled(to y: CGFloat) { handle(.scrolled(y)) }

  // MARK: The page

  @objc func goBack(_ sender: Any?) { web.goBack() }
  @objc func goForward(_ sender: Any?) { web.goForward() }

  func go(to url: URL) {
    load(url)
    window?.makeFirstResponder(web)
    endEditing()
  }

  private func load(_ url: URL) {
    ownLoad = true
    web.load(URLRequest(url: url))
  }

  /// What the tab shows now: a saved page by the address it was saved from
  var page: WebReading.Page {
    guard let url = web.url, url.scheme == WebReading.savedScheme, let hash = url.host(), let s = savedPages[hash]
    else { return .online(web.url) }
    return .saved(hash: hash, address: s.address, title: s.title)
  }

  /// The address the bar shows and edits
  private var address: URL? {
    if case .saved(_, let address, _) = page { address } else { web.url }
  }

  private var onSaved: Bool {
    if case .saved = page { true } else { false }
  }

  /// The site's data is gone: its page again by address, not `reload()`, which would send a form's answer again. A
  /// saved page has no site data to lose
  private func siteDataCleared(_ domain: String?) {
    guard let url = web.url, ["http", "https"].contains(url.scheme), let host = url.host(),
      domain.map({ WebReading.host(host, isOf: $0) }) ?? true
    else { return }
    load(url)
  }

  private func historyChanged() {
    bar.back.isEnabled = web.canGoBack
    bar.forward.isEnabled = web.canGoForward
  }

  private func pageChanged() {
    if !bar.address.isEditing { bar.address.show(WebAddress.shown(address)) }
    // before its first page the tab keeps what it was opened with
    if web.url != nil {
      let page = page
      let own = web.title.flatMap { $0.isEmpty ? nil : $0 }
      let title = if case .saved(_, _, let saved) = page { own ?? saved } else { own ?? WebAddress.shown(address) }
      var payload = page.payload
      if onSaved, language != .original { payload["view"] = language.rawValue }
      // a page online is gone to by no key: leaving a saved page clears its
      context.update(title: title, payload: payload, key: page.key ?? "")
    }
    if web.url != savedFor { askSaved() }
    bar.extract.isEnabled = onSaved && scripts != nil && store != nil
    bar.extract.toolTip =
      if bar.extract.isEnabled {
        nil
      } else if scripts == nil {
        "Body view needs the saving service's page scripts, which are not on this Mac"
      } else if store == nil {
        "Body view needs the saving service, which is not set up on this Mac"
      } else {
        "Body view is for saved pages"
      }
    showTranslation()
  }

  /// A saved page runs none of its own scripts and gets the reader; an online page its scripts and the saving
  /// service's. A saved page loads nothing by itself: only the tab takes it to another page
  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction, preferences: WKWebpagePreferences,
    decisionHandler: @escaping @MainActor (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
  ) {
    guard action.targetFrame?.isMainFrame != false, let url = action.request.url else {
      return decisionHandler(.allow, preferences)
    }
    let ours = ownLoad
    ownLoad = false
    let toSaved = url.scheme == WebReading.savedScheme
    if onSaved, !toSaved, action.navigationType == .other, !ours {
      refused.append(url)
      return decisionHandler(.cancel, preferences)
    }
    preferences.allowsContentJavaScript = !toSaved
    useScripts(forSaved: toSaved)
    decisionHandler(.allow, preferences)
  }

  private func useScripts(forSaved saved: Bool) {
    guard scriptsForSaved != saved else { return }
    scriptsForSaved = saved
    userScripts.removeAllUserScripts()
    userScripts.addUserScript(scroll)
    for s in (saved ? scripts?.saved : scripts?.online) ?? [] { userScripts.addUserScript(s) }
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    capture?.cancel()
  }

  /// Another page in place of this one; one that fails to come leaves this one as it was
  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { stopTranslating() }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    handle(.loaded)
    record(counted: true)
    read()
  }

  // MARK: Body or full page

  private var readerMode: String { bar.extract.selectedSegment == 1 ? "full" : "body" }

  /// A saved page loaded: the reader given its site's rule files, in the mode chosen, then asked for its blocks
  private func read() {
    guard case .saved(_, let address, _) = page, scripts != nil, let store else { return }
    let url = web.url
    Task {
      let files = ((try? await store.rules(forHost: address.host() ?? "")) ?? []).compactMap {
        try? JSONSerialization.jsonObject(with: $0)
      }
      guard web.url == url else { return }
      _ = try? await web.callAsyncJavaScript(
        "return await shiyiReader.apply({files, url, mode})",
        arguments: ["files": files, "url": address.absoluteString, "mode": readerMode],
        contentWorld: WebReading.scriptWorld)
      guard web.url == url else { return }
      await readBlocks()
    }
  }

  @objc func extractChosen(_ sender: Any?) {
    guard onSaved, scripts != nil else { return }
    web.callAsyncJavaScript(
      "return await shiyiReader.setMode(mode)", arguments: ["mode": readerMode], in: nil, in: WebReading.scriptWorld)
  }

  /// The page in the history: a visit when it has loaded, its title when that comes (often after it has loaded)
  private func record(counted: Bool) {
    guard let url = web.url, ["http", "https"].contains(url.scheme), counted || web.title?.isEmpty == false,
      let file = historyFile
    else { return }
    let title = web.title
    Task { await WebHistoryFile.shared.visit(url, title: title, at: Date(), counted: counted, in: file) }
  }

  /// A page asking for a new window (window.open, a link to _blank) gets another web tab after this one, its view
  /// made with the configuration WebKit hands over, so that the two pages reach each other (`window.opener`)
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    let title = action.request.url?.host() ?? "New Tab"
    return (context.open(title, kind: WebReading.kind, handing: configuration) as? WebPageView)?.web
  }

  // MARK: Translation

  /// Where a saved page's translations are kept: the version of its entry it is, and what they are now
  private struct Kept: Sendable {
    var vault: Vault
    var entry: String
    var version: VersionID
    var file: PageTranslations
  }

  /// Why the language buttons are off; none: they are on
  private var translationOff: String? {
    if !onSaved { return "Translation is for pages saved whole: save the full page first" }
    if scripts == nil { return "Translation needs the saving service's page scripts, which are not on this Mac" }
    if translator == nil { return "Translation needs the AI, which is not set up" }
    if readerLacksBlocks { return "Translation needs newer page scripts of the saving service than those on this Mac" }
    if blocks == nil { return "The page is being read" }
    if let keptError { return keptError }
    if kept == nil { return "Translations are kept in the page's entry, which is not in the open vault" }
    return nil
  }

  private func showTranslation() {
    bar.show(
      translationOff.map(WebBar.Translate.off)
        ?? progress.map { .translating(done: $0.done, of: $0.of) }
        ?? translationFailure.map(WebBar.Translate.failed) ?? .ready)
  }

  /// The reader's blocks of the saved page, then its kept translations shown
  private func readBlocks() async {
    guard translator != nil else { return }
    let r = try? await web.callAsyncJavaScript(
      """
      if (typeof shiyiReader.blocks != "function") return null
      const r = await shiyiReader.blocks()
      return { scheme: r.scheme, blocks: r.blocks, lang: document.documentElement.lang }
      """, contentWorld: WebReading.scriptWorld)
    guard let d = r as? [String: Any], let scheme = d["scheme"] as? Int, let list = d["blocks"] as? [Any] else {
      readerLacksBlocks = true
      return showTranslation()
    }
    let lang = (d["lang"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    blocks = (scheme, lang, list.compactMap(WebBlock.init(script:)))
    showTranslation()
    await takeKept()
  }

  /// The translations kept for this saved page in its entry, read and shown, and the page shown as the tab says
  private func takeKept() async {
    guard case .saved(let hash, _, _) = page, let blocks, let vault = context.pane.vault,
      let found = context.pane.entries.all.lazy.compactMap({ f in
        f.entry.versions.first { if case .page(hash, _, _) = $0.content { true } else { false } }.map {
          (f.path, $0.id)
        }
      }).first
    else { return showTranslation() }
    let (entry, version) = found
    do {
      let file = try vault.translations(of: version, language: WebReading.translationLanguage, in: entry)
      // a file written before translations were listed gets its Version now
      if file != nil,
        let e = try vault.listTranslations(of: version, language: WebReading.translationLanguage, in: entry)
      {
        context.pane.entries.update(e, at: entry)
      }
      kept = Kept(
        vault: vault, entry: entry, version: version,
        file: file.flatMap { $0.scheme == blocks.scheme ? $0 : nil } ?? PageTranslations(scheme: blocks.scheme))
    } catch {
      keptError = "The page's translations could not be read: \(error)"
      return showTranslation()
    }
    showTranslation()
    let stored = kept?.file.blocks ?? [:]
    var shown: [String: String] = [:]
    for b in blocks.list {
      if let t = stored[b.id], t.hash == b.hash { shown[b.id] = t.text }
    }
    if !shown.isEmpty { await setTranslations(shown) }
    if language != .original { await show(language) }
  }

  private func setTranslations(_ texts: [String: String]) async {
    _ = try? await web.callAsyncJavaScript(
      "shiyiReader.setTranslations(texts)", arguments: ["texts": texts], contentWorld: WebReading.scriptWorld)
  }

  @objc func translateChosen(_ sender: Any?) {
    language = WebReading.Language.allCases[bar.translate.selectedSegment]
    pageChanged()
    Task { await show(language) }
  }

  /// The page shown in `language`, the blocks it lacks translated
  private func show(_ language: WebReading.Language) async {
    guard translationOff == nil else { return }
    _ = try? await web.callAsyncJavaScript(
      "shiyiReader.setLanguage(language)", arguments: ["language": language.rawValue],
      contentWorld: WebReading.scriptWorld)
    if language != .original { translateRest() }
  }

  /// The blocks without a kept translation of their text translated, from the one at the top of the window, each
  /// batch shown and kept as it comes
  private func translateRest() {
    guard translating == nil, let translator, let blocks, let stored = kept?.file.blocks else { return }
    translationFailure = nil
    translating = Task { [weak self, web] in
      let top =
        try? await web.callAsyncJavaScript(
          "return shiyiReader.position()?.id ?? null", contentWorld: WebReading.scriptWorld) as? String
      let batches = WebTranslating.batches(blocks.list, stored: stored, top: top)
      guard !Task.isCancelled else { return }
      self?.progress = (0, batches.reduce(0) { $0 + $1.count })
      self?.showTranslation()
      let outcome = await WebTranslating.run(
        batches, from: blocks.lang, to: WebReading.translationLanguage, translate: translator
      ) { [weak self] in self?.took($0) }
      guard !Task.isCancelled else { return }
      self?.ran(outcome)
    }
  }

  private func took(_ done: [String: PageTranslations.Block]) {
    guard var k = kept else { return }
    k.file.blocks.merge(done) { $1 }
    kept = k
    progress?.done += done.count
    showTranslation()
    Task { await setTranslations(done.mapValues(\.text)) }
    let before = writing
    writing = Task { [weak self] in
      await before?.value
      switch await Self.write(k) {
      case .success(let listed?): self?.context.pane.entries.update(listed, at: k.entry)
      case .success(nil): break
      case .failure(let why):
        self?.translationFailure = why.message
        self?.showTranslation()
      }
    }
  }

  /// Off the main thread: a long page's file is written again after every batch. The entry when the first write
  /// listed the translations in it
  @concurrent private static func write(_ k: Kept) async -> Result<Entry?, Unsaved> {
    do {
      return .success(try k.vault.write(k.file, of: k.version, language: WebReading.translationLanguage, in: k.entry))
    } catch {
      return .failure(Unsaved(message: "The translations could not be saved: \(error)"))
    }
  }

  private struct Unsaved: Error {
    var message: String
  }

  private func ran(_ outcome: WebTranslating.Outcome) {
    translating = nil
    progress = nil
    let n = outcome.failed.count
    if n > 0 {
      let why = outcome.error.map { ": \($0.localizedDescription)" } ?? ""
      translationFailure =
        "\(n == 1 ? "A block" : "\(n) blocks") could not be translated\(why). Choose Side by Side or Translation "
        + "again to try again"
    }
    showTranslation()
  }

  /// Leaving the page: its translating stops, and what was read of it is let go
  private func stopTranslating() {
    translating?.cancel()
    translating = nil
    (blocks, kept, keptError, progress, translationFailure, readerLacksBlocks) = (nil, nil, nil, nil, nil, false)
    showTranslation()
  }

  // MARK: Saving

  @objc func saveClicked(_ sender: Any?) {
    if let capture { return capture.cancel() }
    saveMenu().popUp(positioning: nil, at: CGPoint(x: 0, y: bar.save.bounds.height + 4), in: bar.save)
  }

  /// The two levels of saving
  func saveMenu() -> NSMenu {
    let menu = NSMenu()
    menu.autoenablesItems = false
    let link = NSMenuItem(title: "Save Link", action: #selector(saveLink(_:)), keyEquivalent: "")
    let page = NSMenuItem(title: "Save Full Page", action: #selector(savePage(_:)), keyEquivalent: "")
    for item in [link, page] {
      item.target = self
      menu.addItem(item)
    }
    page.isEnabled = scripts != nil && store != nil
    page.toolTip =
      if scripts == nil {
        "Saving a page whole needs the saving service's page scripts, which are not on this Mac"
      } else if store == nil {
        "Saving a page whole needs the saving service, which is not set up on this Mac"
      } else {
        nil
      }
    return menu
  }

  /// Escape stops a saving under way; with none it goes on up the chain (NSView has no cancelOperation of its own to
  /// call: super would throw)
  override func cancelOperation(_ sender: Any?) {
    guard let capture else {
      nextResponder?.doCommand(by: #selector(NSResponder.cancelOperation(_:)))
      return
    }
    capture.cancel()
  }

  /// The link in its entry in the vault at once, by the page's title, so that the button, the sidebar and the lists
  /// answer the press. What the metadata script reads of the page is added when it answers (asked while the page is
  /// being left for another, WebKit never answers, and the link stays as it is); the saving service, when there is
  /// one, is told afterwards too: it may have to start first
  @objc func saveLink(_ sender: Any?) {
    guard context.pane.vault != nil, let url = web.url, ["http", "https"].contains(url.scheme) else { return }
    let first = WebMeta(script: nil, title: web.title ?? "")
    let name = first.title ?? WebAddress.shown(url)
    let item = SavedItem(
      id: "", kind: .link, url: url.absoluteString, title: name, savedAt: Int64(first.fetchedAt ?? 0))
    do {
      try context.pane.saveWeb(item, meta: first)
    } catch {
      showSave(.failed("The link could not be saved: \(error.localizedDescription)"))
      return
    }
    if saved == .unsaved { saved = .link }
    if capture == nil { showSaved() }
    if let store { Task { _ = try? await store.saveLink(PageLink(url: item.url, title: name)) } }
    guard scripts != nil else { return }
    Task {
      guard
        let read = try? await web.callAsyncJavaScript(
          "return await shiyiCapture.meta()", contentWorld: WebReading.scriptWorld)
      else { return }
      let meta = WebMeta(script: read, title: name)
      var named = item
      named.title = meta.title ?? name
      try? context.pane.saveWeb(named, meta: meta)
    }
  }

  /// The page captured whole, kept by the saving service and listed as one more version of its entry
  @objc func savePage(_ sender: Any?) {
    guard capture == nil, scripts != nil, let store, context.pane.vault != nil, let url = web.url,
      ["http", "https"].contains(url.scheme)
    else { return }
    let (title, cookies) = (web.title ?? "", web.configuration.websiteDataStore.httpCookieStore)
    let capture = WebCapture(web: web) { [weak self] stage in self?.showSave(.saving(stage: stage)) }
    self.capture = capture
    showSave(.saving(stage: ""))
    Task {
      defer { if self.capture === capture { self.capture = nil } }
      do {
        async let jar = cookies.allCookies()
        let files = (try? await store.rules(forHost: url.host() ?? "")) ?? []
        let (file, script) = try await capture.run(files: files, cookies: await jar)
        defer { try? FileManager.default.removeItem(at: file) }
        let meta = WebMeta(script: script, title: title)
        let item: SavedItem
        do {
          item = try await store.savePage(
            PageCapture(url: url.absoluteString, title: meta.title ?? WebAddress.shown(url)), file: file)
          try context.pane.saveWeb(item, meta: meta)
        } catch {
          throw WebSaveError(code: "store", message: error.localizedDescription)
        }
        if web.url == url, let hash = item.pageHash { saved = .page(hash: hash) }
        showSaved()
      } catch is CancellationError {
        showSaved()
      } catch let e as WebSaveError {
        showSave(.failed(e.shown))
      } catch {
        showSave(.failed(WebSaveError(code: "internal", message: error.localizedDescription).shown))
      }
    }
  }

  /// The vault's entries were read again
  func entriesRead() {
    askSaved()
    if blocks != nil, kept == nil, keptError == nil { Task { await takeKept() } }
  }

  /// A new address, or the entries read again: how it is saved, from the vault
  private func askSaved() {
    savedFor = web.url
    saved =
      if case .saved(let hash, _, _) = page {
        .page(hash: hash)
      } else if let url = web.url, ["http", "https"].contains(url.scheme) {
        context.pane.webSaved(url)
      } else {
        .unsaved
      }
    if capture == nil { showSaved() }
  }

  private func showSaved() {
    guard context.pane.vault != nil else { return showSave(.off("Saving needs an open vault")) }
    if onSaved { return showSave(.off("This is the page as it was saved")) }
    guard let url = web.url, ["http", "https"].contains(url.scheme) else {
      return showSave(.off("No page to save"))
    }
    showSave(.saved(saved))
  }

  private func showSave(_ state: WebBar.Save) {
    saveState = state
    bar.show(state)
  }

  // MARK: The address

  /// File > Open Location (⌘L): the address, all of it selected
  @objc func openLocation(_ sender: Any?) {
    handle(.openLocation)
    window?.makeFirstResponder(bar.address)
  }

  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    let r = window?.firstResponder as? NSView
    guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
      event.charactersIgnoringModifiers == "l", let r, r === self || r.isDescendant(of: self)
    else { return super.performKeyEquivalent(with: event) }
    openLocation(nil)
    return true
  }

  private func beginEditing() {
    bar.address.stringValue = address?.absoluteString ?? ""
    typed = bar.address.stringValue
    handle(.editing(true))
    guard let file = historyFile else { return }
    Task { [weak self] in
      let h = await WebHistoryFile.shared.read(file)
      self?.history = h
    }
  }

  private func endEditing() {
    suggestions.show([])
    bar.address.show(WebAddress.shown(address))
    handle(.editing(false))
  }

  func controlTextDidChange(_ note: Notification) {
    typed = bar.address.stringValue
    suggestions.show(history.matches(typed))
    needsLayout = true
  }

  func controlTextDidEndEditing(_ note: Notification) { endEditing() }

  func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
    switch selector {
    case #selector(NSResponder.insertNewline(_:)):
      // not an address: nothing is searched for, the address stays as typed for another try
      guard let url = WebAddress.url(from: bar.address.stringValue) else {
        NSSound.beep()
        return true
      }
      go(to: url)
    case #selector(NSResponder.cancelOperation(_:)):
      bar.address.abortEditing()
      window?.makeFirstResponder(web)
      endEditing()
    case #selector(NSResponder.moveUp(_:)), #selector(NSResponder.moveDown(_:)):
      let entry = suggestions.move(by: selector == #selector(NSResponder.moveUp(_:)) ? 1 : -1)
      bar.address.stringValue = entry?.url.absoluteString ?? typed
      textView.selectedRange = NSRange(location: (bar.address.stringValue as NSString).length, length: 0)
    default: return false
    }
    return true
  }
}

/// Hands the page's scroll offsets to the view without the content controller keeping the view alive
private final class ScrollRelay: NSObject, WKScriptMessageHandler {
  weak var owner: WebPageView?

  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let y = message.body as? Double else { return }
    owner?.scrolled(to: CGFloat(y))
  }
}
