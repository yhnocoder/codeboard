import AppKit
import CodeBoardModel
import SwiftUI

/// Shows the result of an import as a sheet: counts first, the failures and what was left out behind a disclosure. A
/// SwiftUI sheet rather than NSAlert, because an alert does not grow when its accessory view opens.
@MainActor func presentImport(_ result: Result<ImportReport, any Error>, on window: NSWindow) {
  let summary: ImportSummary
  switch result {
  case .failure(let error): summary = ImportSummary(title: "Nothing was imported", subtitle: String(describing: error))
  case .success(let report): summary = ImportSummary(report)
  }
  let content = NSHostingController(rootView: ImportSheet(summary: summary))
  // The sheet grows when Details opens
  content.sizingOptions = .preferredContentSize
  window.beginSheet(NSWindow(contentViewController: content))
}

/// The words of an import result
struct ImportSummary: Equatable {
  var title: String
  var subtitle: String
  var details: [String] = []

  init(title: String, subtitle: String) {
    self.title = title
    self.subtitle = subtitle
  }

  init(_ report: ImportReport) {
    let boards = report.imported.filter { $0.destination?.hasSuffix(".\(Vault.packageExtension)") == true }.count
    let cards = report.imported.filter { $0.destination?.hasPrefix(Vault.appDataFolder + "/") == true }.count
    var made = [count(boards, "board")]
    if cards > 0 { made.append(count(cards, "shared card")) }
    title = "Imported " + made.joined(separator: " and ")
    var left: [SkipKind: Int] = [:]
    for entry in report.imported {
      for skip in entry.skipped { left[skip.kind, default: 0] += skip.count }
    }
    var notes: [String] = []
    if !report.failed.isEmpty { notes.append("\(count(report.failed.count, "file")) could not be imported.") }
    let leftTotal = left.values.reduce(0, +)
    if leftTotal > 0 { notes.append("\(count(leftTotal, "item")) left out, which this version does not show yet.") }
    subtitle = notes.joined(separator: " ")
    details =
      report.failed.map { String(describing: $0) }
      + SkipKind.allCases.compactMap { kind in left[kind].map { "\(Self.name(of: kind)): \($0)" } }
  }

  /// `webCard` → "web card"
  static func name(of kind: SkipKind) -> String {
    kind.rawValue.reduce(into: "") { out, c in out += c.isUppercase ? " " + c.lowercased() : String(c) }
  }
}

private func count(_ n: Int, _ noun: String) -> String {
  "\(n) \(noun)\(n == 1 ? "" : "s")"
}

private struct ImportSheet: View {
  let summary: ImportSummary
  @State private var open = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(summary.title).font(.headline)
      if !summary.subtitle.isEmpty {
        Text(summary.subtitle).font(.callout).fixedSize(horizontal: false, vertical: true)
      }
      if !summary.details.isEmpty {
        DisclosureGroup("Details", isExpanded: $open) {
          ScrollView {
            Text(summary.details.joined(separator: "\n"))
              .font(.callout)
              .textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .frame(height: 180)
        }
      }
      HStack {
        Spacer()
        Button("OK") {
          // The sheet is the key window while its button is clicked
          if let sheet = NSApp.keyWindow { sheet.sheetParent?.endSheet(sheet) }
        }.keyboardShortcut(.defaultAction)
      }
    }
    .padding(20)
    .frame(width: 380)
  }
}
