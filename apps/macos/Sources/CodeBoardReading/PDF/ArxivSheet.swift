import AppKit

/// Add arXiv or DOI Paper…: one field for an arXiv id, a DOI or an address of either, Translate (off, with why, when
/// tongtu is not found; an arXiv paper's only), Add and Cancel. While it adds, a spinner stands where Add was; what went
/// wrong is said under the field in plain words, and the sheet stays for another try. The adding itself is the shell's
/// (Shell.addPaper), given as `add`: nil when it went through, else the message
@MainActor public final class ArxivSheet: NSObject, NSTextFieldDelegate {
  public let window: NSPanel
  let field = NSTextField()
  let translate = NSButton(checkboxWithTitle: "Translate", target: nil, action: nil)
  let addButton = NSButton(title: "Add", target: nil, action: nil)
  let cancelButton = NSButton(title: "Cancel", target: nil, action: nil)
  let spinner = NSProgressIndicator()
  let error = NSTextField(wrappingLabelWithString: "")
  private let add: (String, Bool) async -> String?
  private let done: () -> Void

  /// `missing`: why translating cannot be asked for (tongtu not found); `done`: the sheet is to go
  public init(missing: String?, add: @escaping (String, Bool) async -> String?, done: @escaping () -> Void) {
    self.add = add
    self.done = done
    window = NSPanel(
      contentRect: CGRect(x: 0, y: 0, width: 420, height: 150), styleMask: [.titled], backing: .buffered, defer: true)
    super.init()
    field.placeholderString = "1706.03762, 10.1145/… or an address"
    field.delegate = self
    field.setAccessibilityIdentifier("ui-arxivfield")
    translate.setAccessibilityIdentifier("ui-arxivtranslate")
    if let missing {
      translate.isEnabled = false
      translate.toolTip = missing
    }
    let reason = NSTextField(labelWithString: missing.map { _ in "tongtu was not found" } ?? "")
    reason.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
    reason.textColor = .secondaryLabelColor
    reason.toolTip = missing
    addButton.keyEquivalent = "\r"
    addButton.target = self
    addButton.action = #selector(addPressed)
    addButton.setAccessibilityIdentifier("ui-arxivadd")
    cancelButton.keyEquivalent = "\u{1b}"
    cancelButton.target = self
    cancelButton.action = #selector(cancelPressed)
    cancelButton.setAccessibilityIdentifier("ui-arxivcancel")
    spinner.style = .spinning
    spinner.controlSize = .small
    spinner.isDisplayedWhenStopped = false
    error.textColor = .systemRed
    error.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
    error.setAccessibilityIdentifier("ui-arxiverror")
    let title = NSTextField(labelWithString: "Add a paper from arXiv or by its DOI")
    title.font = .boldSystemFont(ofSize: NSFont.systemFontSize)
    let content = NSView()
    for v in [title, field, translate, reason, error, spinner, cancelButton, addButton] as [NSView] {
      v.translatesAutoresizingMaskIntoConstraints = false
      content.addSubview(v)
    }
    NSLayoutConstraint.activate([
      title.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
      title.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
      field.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 10),
      field.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
      field.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
      error.topAnchor.constraint(equalTo: field.bottomAnchor, constant: 6),
      error.leadingAnchor.constraint(equalTo: field.leadingAnchor),
      error.trailingAnchor.constraint(equalTo: field.trailingAnchor),
      translate.topAnchor.constraint(equalTo: error.bottomAnchor, constant: 6),
      translate.leadingAnchor.constraint(equalTo: field.leadingAnchor),
      reason.firstBaselineAnchor.constraint(equalTo: translate.firstBaselineAnchor),
      reason.leadingAnchor.constraint(equalTo: translate.trailingAnchor, constant: 8),
      addButton.topAnchor.constraint(equalTo: translate.bottomAnchor, constant: 16),
      addButton.trailingAnchor.constraint(equalTo: field.trailingAnchor),
      addButton.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -18),
      cancelButton.centerYAnchor.constraint(equalTo: addButton.centerYAnchor),
      cancelButton.trailingAnchor.constraint(equalTo: addButton.leadingAnchor, constant: -8),
      spinner.centerYAnchor.constraint(equalTo: addButton.centerYAnchor),
      spinner.centerXAnchor.constraint(equalTo: addButton.centerXAnchor),
    ])
    window.contentView = content
    window.initialFirstResponder = field
  }

  @objc func addPressed() {
    let text = field.stringValue
    guard !text.trimmingCharacters(in: .whitespaces).isEmpty, !addButton.isHidden else { return }
    error.stringValue = ""
    addButton.isHidden = true
    field.isEnabled = false
    spinner.startAnimation(nil)
    Task {
      let failed = await add(text, translate.state == .on)
      spinner.stopAnimation(nil)
      addButton.isHidden = false
      field.isEnabled = true
      if let failed { error.stringValue = failed } else { done() }
    }
  }

  @objc func cancelPressed() { done() }
}
