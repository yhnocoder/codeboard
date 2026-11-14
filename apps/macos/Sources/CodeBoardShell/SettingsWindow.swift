import AppKit
import CodeBoardModel

/// The Settings window: how the board switches to its summaries (摘要切换) and the AI key. The key is saved to the
/// KeyStore when the field is committed (Return, leaving it, closing the window); a saved key is never shown, the field
/// then holds a stand-in that shows as dots, and clearing it removes the key.
@MainActor final class SettingsWindow: NSObject, NSWindowDelegate, NSTextFieldDelegate {
  /// What the field holds while a key is saved; committed unchanged, it keeps the key
  static let saved = String(repeating: "•", count: 12)
  let window: NSWindow
  let switchControl = NSSegmentedControl(
    labels: SummarySwitch.allCases.map(\.rawValue), trackingMode: .selectOne, target: nil, action: nil)
  let keyField = NSSecureTextField()
  let keyStatus = NSTextField(labelWithString: "")
  private let settings: AISettings
  private let keys: any KeyStore
  var onSwitchChange: (SummarySwitch) -> Void = { _ in }
  /// Whether a key is saved now
  var onKeyChange: (Bool) -> Void = { _ in }

  init(settings: AISettings, keys: any KeyStore) {
    self.settings = settings
    self.keys = keys
    window = NSWindow(
      contentRect: CGRect(x: 0, y: 0, width: 420, height: 120), styleMask: [.titled, .closable], backing: .buffered,
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
    keyStatus.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
    keyStatus.textColor = .secondaryLabelColor
    let grid = NSGridView(views: [
      [NSTextField(labelWithString: "摘要切换"), switchControl],
      [NSTextField(labelWithString: "API Key"), keyField],
      [NSGridCell.emptyContentView, keyStatus],
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

  private func showKey() {
    let has = keys.key() != nil
    keyField.stringValue = has ? Self.saved : ""
    keyStatus.stringValue = has ? "已保存" : ""
  }

  func controlTextDidEndEditing(_ obj: Notification) { commitKey(nil) }
  func windowWillClose(_ notification: Notification) { commitKey(nil) }
}
