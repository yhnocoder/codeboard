import AppKit
import CodeBoardModel

// ⋯ Copy Diagnostics (host diagnostics.ts copyDiagnostics, core diagnostics.ts formatDiagnostics): asked first whether
// the board's JSON goes along, then the app's and the system's versions, the vault and the board's size (its JSON too)
// on the pasteboard, the home folder written as ~. The app keeps no log, so main's Recent errors and Log are not there.

extension CanvasView {
  /// main's two picks and Cancel, as a sheet on the window
  static func diagnosticsQuestion() -> NSAlert {
    let a = NSAlert()
    a.messageText = "Copy Diagnostics"
    a.informativeText = "Attach board JSON? Versions, workspace and the board’s size are copied either way."
    a.addButton(withTitle: "Copy Diagnostics")
    a.addButton(withTitle: "Copy Diagnostics + Board JSON")
    a.addButton(withTitle: "Cancel")
    return a
  }

  func copyDiagnostics() {
    guard let doc = document, let (vb, vault) = shown, let window else { return }
    let alert = Self.diagnosticsQuestion()
    Task {
      // a sheet on the window, the other windows going on
      let answer = await alert.beginSheetModal(for: window)
      guard answer != .alertThirdButtonReturn, document === doc else { return }
      let json =
        answer == .alertSecondButtonReturn
        ? (try? doc.board.encoded()).map { String(decoding: $0, as: UTF8.self) } : nil
      pasteboard.clearContents()
      pasteboard.setString(
        Self.diagnostics(board: vb.title, doc.board, vault: vault.root, json: json, home: NSHomeDirectory()),
        forType: .string)
      toast("Diagnostics copied to clipboard")
    }
  }

  /// formatDiagnostics with what the app has
  static func diagnostics(board name: String, _ b: Board, vault: URL, json: String?, home: String) -> String {
    let info = Bundle.main.infoDictionary
    let version =
      Bundle.main.bundleIdentifier?.hasPrefix("com.yhnocoder.codeboard") == true
      ? info?["CFBundleShortVersionString"] as? String ?? "dev" : "dev"
    var u = utsname()
    uname(&u)
    func field<T>(_ t: T) -> String {
      withUnsafeBytes(of: t) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }
    let os = ProcessInfo.processInfo.operatingSystemVersion
    var out = [
      "CodeBoard \(version) · macOS \(os.majorVersion).\(os.minorVersion).\(os.patchVersion) · darwin \(field(u.release)) \(field(u.machine))",
      "Workspace: \(vault.path(percentEncoded: false))",
      "Board: “\(name)” · \(b.cards.count) cards · \(b.arrows.count) arrows · \(b.sections.count) sections",
    ]
    if let json { out += ["", "Board JSON:", json] }
    return tildify(out.joined(separator: "\n"), home: home)
  }

  /// The home folder as ~ where it begins a path (core tildify)
  static func tildify(_ text: String, home: String) -> String {
    let h = home.hasSuffix("/") ? String(home.dropLast()) : home
    guard !h.isEmpty,
      let re = try? NSRegularExpression(
        pattern: NSRegularExpression.escapedPattern(for: h) + #"(?=[\\/]|$|[\s"'`:)\]])"#)
    else { return text }
    return re.stringByReplacingMatches(
      in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "~")
  }
}
