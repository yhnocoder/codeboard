import CodeUI
import CoreGraphics
import MarkdownCore
import MarkdownUI

/// Resources and a theme of the component's own tests, for the looks' tests
struct TestResources: MarkdownResources {
  var sizes: [String: CGSize] = [:]
  func imageSize(_ src: String) -> CGSize? { sizes[src] }
  func ref(label: String, target: String?) -> MarkdownRefHit? { .found(title: label, seal: nil) }
  func highlight(lines: [String], language: String) -> [[CodeRun]]? { nil }
  var mathPreamble: String { "" }
}

let testTheme: MarkdownTheme = {
  let c = { MDColor(hex: $0) }
  return MarkdownTheme(
    colors: .init(
      ink: c("#211f1b"), ink2: c("#625e56"), ink3: c("#9a958b"), surface: c("#fdfcfa"),
      fill: MDColor(0.2, 0.2, 0.1, 0.07),
      codeBlock: c("#f5f3ef"), hair: MDColor(0.2, 0.2, 0.1, 0.16), line: MDColor(0.2, 0.2, 0.1, 0.09),
      accent: c("#b5552d"),
      accentInk: c("#ffffff"), warn: c("#c48a1f"), link: c("#2e5d86")),
    code: .init(plain: c("#211f1b")), marks: .init(highlight: MDColor(0.9, 0.8, 0.4, 0.3), annotations: [:]),
    fonts: .init(
      body: ["-apple-system", "PingFang SC"], mono: ["JetBrains Mono", "Menlo"], headings: [["-apple-system"]], hand: []
    ))
}()
