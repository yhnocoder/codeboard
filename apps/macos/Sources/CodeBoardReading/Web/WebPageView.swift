import AppKit
import WebKit

/// A web page filling its tab, with its bar floating over the page's bottom edge. The bar comes and goes as
/// `WebBarVisibility` says, moving over the page: the page is never laid out again for it
final class WebPageView: NSView, NSTextFieldDelegate, WKNavigationDelegate, WKUIDelegate {
  let web: WKWebView
  let bar: WebBar
  let suggestions: WebSuggestions
  private let context: WebReading.Context
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
  private var historyFile: URL { context.dataDirectory.appending(path: "history.json") }
  static let slide: TimeInterval = 0.18

  /// Scroll offsets, posted from the page's scroll events in a world of their own so that the page's scripts neither
  /// see nor fake them. WebKit sends scroll events once per frame at most, as the page is drawn, so the main thread
  /// hears of a scroll no more often than that, and nothing polls
  static let scrollScript = """
    addEventListener("scroll", () => webkit.messageHandlers.scroll.postMessage(scrollY), { passive: true })
    """

  init(url: URL?, context: WebReading.Context) {
    self.context = context
    let config = WKWebViewConfiguration()
    config.websiteDataStore = context.websiteData
    config.applicationNameForUserAgent = WebReading.applicationName
    let relay = ScrollRelay()
    config.userContentController.add(relay, contentWorld: .defaultClient, name: "scroll")
    config.userContentController.addUserScript(
      WKUserScript(
        source: Self.scrollScript, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .defaultClient))
    scripts = WebScripts(context.scripts)
    let saving = SavingRelay()
    if let scripts {
      for s in scripts.online { config.userContentController.addUserScript(s) }
      config.userContentController.addScriptMessageHandler(saving, contentWorld: WebReading.scriptWorld, name: "shiyi")
    }
    web = WKWebView(frame: .zero, configuration: config)
    bar = WebBar(radius: context.look.radius)
    suggestions = WebSuggestions(radius: context.look.radius)
    editOnShow = url == nil
    super.init(frame: .zero)
    setAccessibilityIdentifier("ui-web")
    relay.owner = self
    saving.owner = self
    web.allowsBackForwardNavigationGestures = true
    web.navigationDelegate = self
    web.uiDelegate = self
    web.autoresizingMask = [.width, .height]
    web.setAccessibilityIdentifier("ui-web-page")
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
      forName: WebReading.siteDataCleared, object: context.websiteData, queue: .main
    ) { [weak self] note in
      let domain = note.userInfo?["domain"] as? String
      MainActor.assumeIsolated { self?.siteDataCleared(domain) }
    }
    historyChanged()
    pageChanged()
    if let url { web.load(URLRequest(url: url)) }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("WebPageView is not loaded from nibs") }

  isolated deinit {
    if let clearedObserver { NotificationCenter.default.removeObserver(clearedObserver) }
  }

  override var isFlipped: Bool { true }

  override func layout() {
    super.layout()
    web.frame = bounds
    bar.frame = barFrame(shown: barShown)
    let b = barFrame(shown: true)
    suggestions.frame = CGRect(
      x: b.minX, y: b.minY - 6 - suggestions.height, width: b.width, height: suggestions.height)
  }

  private func barFrame(shown: Bool) -> CGRect {
    let look = context.look
    let y = bounds.height - look.bottom - look.height
    return CGRect(
      x: look.side, y: shown ? y : bounds.height + look.radius, width: max(0, bounds.width - 2 * look.side),
      height: look.height)
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
    web.load(URLRequest(url: url))
    window?.makeFirstResponder(web)
    endEditing()
  }

  /// The site's data is gone: its page again by address, not `reload()`, which would send a form's answer again
  private func siteDataCleared(_ domain: String?) {
    guard let url = web.url, let host = url.host(), domain.map({ WebReading.host(host, isOf: $0) }) ?? true else {
      return
    }
    web.load(URLRequest(url: url))
  }

  private func historyChanged() {
    bar.back.isEnabled = web.canGoBack
    bar.forward.isEnabled = web.canGoForward
  }

  private func pageChanged() {
    if !bar.address.isEditing { bar.address.show(WebAddress.shown(web.url)) }
    context.changed(web.title, web.url)
    if web.url != savedFor { askSaved() }
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    capture?.cancel()
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    handle(.loaded)
    record(counted: true)
  }

  /// The page in the history: a visit when it has loaded, its title when that comes (often after it has loaded)
  private func record(counted: Bool) {
    guard let url = web.url, ["http", "https"].contains(url.scheme), counted || web.title?.isEmpty == false else {
      return
    }
    let (title, file) = (web.title, historyFile)
    Task { await WebHistoryFile.shared.visit(url, title: title, at: Date(), counted: counted, in: file) }
  }

  /// A link to a new window opens here
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    webView.load(action.request)
    return nil
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
    if scripts == nil {
      page.isEnabled = false
      page.toolTip = "Saving a page whole needs the saving service's page scripts, which are not on this Mac"
    }
    return menu
  }

  /// Escape stops a saving under way
  override func cancelOperation(_ sender: Any?) {
    guard let capture else { return super.cancelOperation(sender) }
    capture.cancel()
  }

  @objc func saveLink(_ sender: Any?) {
    guard let saving = context.saving, let url = web.url else { return }
    let title = web.title ?? ""
    Task {
      let script =
        scripts == nil
        ? nil
        : try? await web.callAsyncJavaScript(
          "return await shiyiCapture.meta()", contentWorld: WebReading.scriptWorld)
      do {
        try await saving.saveLink(WebReading.PageMeta(script: script, url: url, title: title))
        if web.url == url, saved == .unsaved { saved = .link }
        if capture == nil { showSaved() }
      } catch {
        showSave(.failed("The link could not be saved: \(error.localizedDescription)"))
      }
    }
  }

  @objc func savePage(_ sender: Any?) {
    guard capture == nil, scripts != nil, let saving = context.saving, let url = web.url else { return }
    let (title, cookies) = (web.title ?? "", context.websiteData.httpCookieStore)
    let capture = WebCapture(web: web) { [weak self] stage in self?.showSave(.saving(stage: stage)) }
    self.capture = capture
    showSave(.saving(stage: ""))
    Task {
      defer { if self.capture === capture { self.capture = nil } }
      do {
        async let jar = cookies.allCookies()
        let files = await saving.rules(forHost: url.host() ?? "")
        let (file, script) = try await capture.run(files: files, cookies: await jar)
        defer { try? FileManager.default.removeItem(at: file) }
        let hash: String
        do {
          hash = try await saving.savePage(WebReading.PageMeta(script: script, url: url, title: title), file: file)
        } catch {
          throw WebSaveError(code: "store", message: error.localizedDescription)
        }
        if web.url == url { saved = .page(hash: hash) }
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

  /// A new address: how it is saved, from the owner
  private func askSaved() {
    savedFor = web.url
    saved = .unsaved
    if capture == nil { showSaved() }
    guard let saving = context.saving, let url = web.url, ["http", "https"].contains(url.scheme) else { return }
    Task {
      let s = await saving.saved(url)
      guard web.url == url else { return }
      saved = s
      if capture == nil { showSaved() }
    }
  }

  private func showSaved() {
    guard context.saving != nil else { return showSave(.off("Saving is not set up")) }
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
    bar.address.stringValue = web.url?.absoluteString ?? ""
    typed = bar.address.stringValue
    handle(.editing(true))
    let file = historyFile
    Task { [weak self] in
      let h = await WebHistoryFile.shared.read(file)
      self?.history = h
    }
  }

  private func endEditing() {
    suggestions.show([])
    bar.address.show(WebAddress.shown(web.url))
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
