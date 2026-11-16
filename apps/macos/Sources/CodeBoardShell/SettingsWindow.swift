import AppKit
import CodeBoardModel
import CodeBoardResources

/// The Settings window: how the board switches to its summaries (摘要切换), the AI key, and the address and model the
/// summaries are asked of (the VS Code settings ai.deepseekBaseUrl and ai.deepseekModel; empty: DeepSeek's, shown as
/// the fields' placeholders). The key is saved to the KeyStore when the field is committed (Return, leaving it, closing
/// the window); a saved key is never shown, the field then holds a stand-in that shows as dots, and clearing it removes
/// the key. The address and the model are saved the same way, to the defaults.
/// Where tongtu is (translating papers) is this machine's: typed, or chosen with Choose…; empty, it is looked for
/// in PATH and the usual places. Under Search, Related by Meaning's (search.embeddingUrl, search.embeddingModel,
/// search.rerank, search.rerankModel; an empty address is off): its key is saved as the AI key is, to its own
/// KeyStore, the rest to the defaults, read the next time ⌘K opens.
@MainActor final class SettingsWindow: NSObject, NSWindowDelegate, NSTextFieldDelegate {
  /// What the field holds while a key is saved; committed unchanged, it keeps the key
  static let saved = String(repeating: "•", count: 12)
  let window: NSWindow
  let switchControl = NSSegmentedControl(
    labels: SummarySwitch.allCases.map(\.rawValue), trackingMode: .selectOne, target: nil, action: nil)
  let keyField = NSSecureTextField()
  let keyStatus = NSTextField(labelWithString: "")
  let baseURLField = NSTextField()
  let modelField = NSTextField()
  let tongtuField = NSTextField()
  let tongtuStatus = NSTextField(labelWithString: "")
  let embeddingURLField = NSTextField()
  let embeddingModelField = NSTextField()
  let embeddingKeyField = NSSecureTextField()
  let embeddingKeyStatus = NSTextField(labelWithString: "")
  let rerankSwitch = NSButton(checkboxWithTitle: "Reorder with a reranking model", target: nil, action: nil)
  let rerankModelField = NSTextField()
  private(set) var grid = NSGridView()
  private let settings: AISettings
  private let keys: any KeyStore
  private let search: SearchSettings
  private let searchKeys: any KeyStore
  var onSwitchChange: (SummarySwitch) -> Void = { _ in }
  /// The key, the address or the model changed: whether a key is saved now
  var onKeyChange: (Bool) -> Void = { _ in }

  init(settings: AISettings, keys: any KeyStore, search: SearchSettings, searchKeys: any KeyStore) {
    self.settings = settings
    self.keys = keys
    self.search = search
    self.searchKeys = searchKeys
    window = NSWindow(
      contentRect: CGRect(x: 0, y: 0, width: 460, height: 440), styleMask: [.titled, .closable], backing: .buffered,
      defer: false)
    super.init()
    window.title = "Settings"
    window.isReleasedWhenClosed = false
    window.delegate = self
    switchControl.target = self
    switchControl.action = #selector(switchChanged(_:))
    switchControl.selectedSegment = SummarySwitch.allCases.firstIndex(of: settings.summarySwitch) ?? 0
    for (f, placeholder) in [(keyField, "sk-…"), (embeddingKeyField, "Optional")] {
      f.placeholderString = placeholder
      f.delegate = self
      f.target = self
      f.action = #selector(commitKey(_:))
      f.widthAnchor.constraint(equalToConstant: 260).isActive = true
    }
    for (f, value, placeholder, action) in [
      (baseURLField, settings.baseURL, OpenAISummaryWriter.defaultBase, #selector(commitAI(_:))),
      (modelField, settings.model, OpenAISummaryWriter.defaultModel, #selector(commitAI(_:))),
      (embeddingURLField, search.embeddingURL, "Off, e.g. http://127.0.0.1:11001/v1", #selector(commitSearch(_:))),
      (embeddingModelField, search.embeddingModel, "The first with “embed” in its name", #selector(commitSearch(_:))),
      (rerankModelField, search.rerankModel, "The first with “rerank” in its name", #selector(commitSearch(_:))),
    ] {
      f.stringValue = value
      f.placeholderString = placeholder
      f.delegate = self
      f.target = self
      f.action = action
      f.widthAnchor.constraint(equalToConstant: 260).isActive = true
    }
    tongtuField.placeholderString = "found in PATH or ~/.local/bin"
    tongtuField.stringValue = settings.tongtuPath
    tongtuField.delegate = self
    tongtuField.target = self
    tongtuField.action = #selector(commitTongtu(_:))
    tongtuField.widthAnchor.constraint(equalToConstant: 260).isActive = true
    rerankSwitch.state = search.rerank ? .on : .off
    rerankSwitch.target = self
    rerankSwitch.action = #selector(commitSearch(_:))
    // the status lines under the keys and tongtu: one line as wide as the fields, a long path cut in its middle
    for status in [keyStatus, tongtuStatus, embeddingKeyStatus] {
      status.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
      status.textColor = .secondaryLabelColor
      status.usesSingleLineMode = true
      status.lineBreakMode = .byTruncatingMiddle
      status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
      status.widthAnchor.constraint(equalToConstant: 260).isActive = true
    }
    let choose = NSButton(title: "Choose…", target: self, action: #selector(chooseTongtu(_:)))
    choose.controlSize = .small
    let tongtuRow = NSStackView(views: [tongtuField, choose])
    let heading = NSTextField(labelWithString: "Search")
    heading.font = .boldSystemFont(ofSize: NSFont.systemFontSize)
    grid = NSGridView(views: [
      [NSTextField(labelWithString: "摘要切换"), switchControl],
      [NSTextField(labelWithString: "API Key"), keyField],
      [NSGridCell.emptyContentView, keyStatus],
      [NSTextField(labelWithString: "API Base URL"), baseURLField],
      [NSTextField(labelWithString: "Model"), modelField],
      [NSTextField(labelWithString: "tongtu"), tongtuRow],
      [NSGridCell.emptyContentView, tongtuStatus],
      [heading, NSGridCell.emptyContentView],
      [NSTextField(labelWithString: "Embedding URL"), embeddingURLField],
      [NSTextField(labelWithString: "Embedding Model"), embeddingModelField],
      [NSTextField(labelWithString: "Embedding API Key"), embeddingKeyField],
      [NSGridCell.emptyContentView, embeddingKeyStatus],
      [NSGridCell.emptyContentView, rerankSwitch],
      [NSTextField(labelWithString: "Rerank Model"), rerankModelField],
    ])
    grid.rowSpacing = 10
    grid.column(at: 0).xPlacement = .trailing
    grid.rowAlignment = .firstBaseline
    grid.translatesAutoresizingMaskIntoConstraints = false
    let content = NSView()
    content.addSubview(grid)
    NSLayoutConstraint.activate([
      grid.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
      grid.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
      grid.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
      grid.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -20),
    ])
    window.contentView = content
    showKey()
    showTongtu()
    window.center()
  }

  func show() { window.makeKeyAndOrderFront(nil) }

  @objc func switchChanged(_ sender: NSSegmentedControl) {
    let s = SummarySwitch.allCases[sender.selectedSegment]
    settings.summarySwitch = s
    onSwitchChange(s)
  }

  /// The AI key, or with the embedding key's field (`sender`) that one, saved to its own KeyStore
  @objc func commitKey(_ sender: Any?) {
    let search = sender as? NSTextField === embeddingKeyField
    let (field, store, status) =
      search ? (embeddingKeyField, searchKeys, embeddingKeyStatus) : (keyField, keys, keyStatus)
    let typed = field.stringValue
    guard typed != Self.saved else { return }
    let key = typed.trimmingCharacters(in: .whitespacesAndNewlines)
    let had = store.key() != nil
    guard !(key.isEmpty && !had) else { return showKey(field) }
    do {
      try store.setKey(key.isEmpty ? nil : key)
      showKey(field)
      if !search { onKeyChange(keys.key() != nil) }
    } catch {
      showStatus(status, "Could not save the key: \(error)")
      status.toolTip = status.stringValue
    }
  }

  /// Related by Meaning's address and models as typed, trimmed, and the rerank switch
  @objc func commitSearch(_ sender: Any?) {
    search.embeddingURL = embeddingURLField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    search.embeddingModel = embeddingModelField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    search.rerankModel = rerankModelField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    search.rerank = rerankSwitch.state == .on
  }

  /// The address and the model as typed, trimmed (empty: DeepSeek's)
  @objc func commitAI(_ sender: Any?) {
    let base = baseURLField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let model = modelField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard base != settings.baseURL || model != settings.model else { return }
    settings.baseURL = base
    settings.model = model
    onKeyChange(keys.key() != nil)
  }

  /// The key fields (or only `only`) as their stores have them
  private func showKey(_ only: NSSecureTextField? = nil) {
    for (field, store, status) in [(keyField, keys, keyStatus), (embeddingKeyField, searchKeys, embeddingKeyStatus)]
    where only == nil || only === field {
      let has = store.key() != nil
      field.stringValue = has ? Self.saved : ""
      showStatus(status, has ? "已保存" : "")
    }
  }

  /// The line under a key; empty, its row folds away, so no gap is left between the key and the next field
  private func showStatus(_ status: NSTextField, _ s: String) {
    status.stringValue = s
    grid.cell(for: status)?.row?.isHidden = s.isEmpty
  }

  @objc func commitTongtu(_ sender: Any?) {
    let typed = tongtuField.stringValue.trimmingCharacters(in: .whitespaces)
    guard typed != settings.tongtuPath else { return }
    settings.tongtuPath = typed
    showTongtu()
  }

  @objc func chooseTongtu(_ sender: Any?) {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = false
    panel.directoryURL = URL(filePath: NSString("~/.local/bin").expandingTildeInPath)
    panel.prompt = "Choose"
    panel.beginSheetModal(for: window) { [weak self] r in
      guard r == .OK, let self, let url = panel.url else { return }
      self.tongtuField.stringValue = url.path
      self.commitTongtu(nil)
    }
  }

  private func showTongtu() {
    let found = Tongtu.find(setting: settings.tongtuPath)
    tongtuStatus.stringValue =
      found.map { "使用 \($0.path)" }
      ?? (settings.tongtuPath.isEmpty ? "未找到 tongtu：翻译不可用" : "这里没有可执行的 tongtu")
    tongtuStatus.toolTip = found?.path
  }

  func controlTextDidEndEditing(_ obj: Notification) {
    let f = obj.object as? NSTextField
    if f === tongtuField {
      commitTongtu(nil)
    } else if f === keyField || f === embeddingKeyField {
      commitKey(f)
    } else if [embeddingURLField, embeddingModelField, rerankModelField].contains(where: { $0 === f }) {
      commitSearch(f)
    } else {
      commitAI(nil)
    }
  }
  func windowWillClose(_ notification: Notification) {
    commitKey(nil)
    commitKey(embeddingKeyField)
    commitAI(nil)
    commitTongtu(nil)
    commitSearch(nil)
  }
}
