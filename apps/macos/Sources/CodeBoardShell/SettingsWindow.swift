import AppKit
import CodeBoardModel
import CodeBoardResources

/// The Settings window: how the board switches to its summaries (摘要切换), the AI key, and the address and model the
/// summaries are asked of (the VS Code settings ai.deepseekBaseUrl and ai.deepseekModel; empty: DeepSeek's, shown as
/// the fields' placeholders). The key is saved to the KeyStore when the field is committed (Return, leaving it, closing
/// the window); a saved key is never shown, the field then holds a stand-in that shows as dots, and clearing it removes
/// the key. The address and the model are saved the same way, to the defaults.
/// Where tongtu is (translating papers) is this machine's: typed, or chosen with Choose…; empty, it is looked for
/// in PATH and the usual places.
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
  private let settings: AISettings
  private let keys: any KeyStore
  var onSwitchChange: (SummarySwitch) -> Void = { _ in }
  /// The key, the address or the model changed: whether a key is saved now
  var onKeyChange: (Bool) -> Void = { _ in }

  init(settings: AISettings, keys: any KeyStore) {
    self.settings = settings
    self.keys = keys
    window = NSWindow(
      contentRect: CGRect(x: 0, y: 0, width: 460, height: 240), styleMask: [.titled, .closable], backing: .buffered,
      defer: false)
    super.init()
    window.title = "Settings"
    window.isReleasedWhenClosed = false
    window.delegate = self
    switchControl.target = self
    switchControl.action = #selector(switchChanged(_:))
    switchControl.selectedSegment = SummarySwitch.allCases.firstIndex(of: settings.summarySwitch) ?? 0
    keyField.placeholderString = "sk-…"
    keyField.delegate = self
    keyField.target = self
    keyField.action = #selector(commitKey(_:))
    keyField.widthAnchor.constraint(equalToConstant: 260).isActive = true
    for (f, value, placeholder) in [
      (baseURLField, settings.baseURL, OpenAISummaryWriter.defaultBase),
      (modelField, settings.model, OpenAISummaryWriter.defaultModel),
    ] {
      f.stringValue = value
      f.placeholderString = placeholder
      f.delegate = self
      f.target = self
      f.action = #selector(commitAI(_:))
      f.widthAnchor.constraint(equalToConstant: 260).isActive = true
    }
    keyStatus.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
    keyStatus.textColor = .secondaryLabelColor
    tongtuField.placeholderString = "found in PATH or ~/.local/bin"
    tongtuField.stringValue = settings.tongtuPath
    tongtuField.delegate = self
    tongtuField.target = self
    tongtuField.action = #selector(commitTongtu(_:))
    tongtuField.widthAnchor.constraint(equalToConstant: 260).isActive = true
    tongtuStatus.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
    tongtuStatus.textColor = .secondaryLabelColor
    let choose = NSButton(title: "Choose…", target: self, action: #selector(chooseTongtu(_:)))
    choose.controlSize = .small
    let tongtuRow = NSStackView(views: [tongtuField, choose])
    let grid = NSGridView(views: [
      [NSTextField(labelWithString: "摘要切换"), switchControl],
      [NSTextField(labelWithString: "API Key"), keyField],
      [NSGridCell.emptyContentView, keyStatus],
      [NSTextField(labelWithString: "API Base URL"), baseURLField],
      [NSTextField(labelWithString: "Model"), modelField],
      [NSTextField(labelWithString: "tongtu"), tongtuRow],
      [NSGridCell.emptyContentView, tongtuStatus],
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

  @objc func commitKey(_ sender: Any?) {
    let typed = keyField.stringValue
    guard typed != Self.saved else { return }
    let key = typed.trimmingCharacters(in: .whitespacesAndNewlines)
    let had = keys.key() != nil
    guard !(key.isEmpty && !had) else { return showKey() }
    do {
      try keys.setKey(key.isEmpty ? nil : key)
      showKey()
      onKeyChange(keys.key() != nil)
    } catch {
      keyStatus.stringValue = "Could not save the key: \(error)"
    }
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

  private func showKey() {
    let has = keys.key() != nil
    keyField.stringValue = has ? Self.saved : ""
    keyStatus.stringValue = has ? "已保存" : ""
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
  }

  func controlTextDidEndEditing(_ obj: Notification) {
    let field = obj.object as? NSTextField
    if field === tongtuField { commitTongtu(nil) } else if field === keyField { commitKey(nil) } else { commitAI(nil) }
  }
  func windowWillClose(_ notification: Notification) {
    commitKey(nil)
    commitAI(nil)
    commitTongtu(nil)
  }
}
