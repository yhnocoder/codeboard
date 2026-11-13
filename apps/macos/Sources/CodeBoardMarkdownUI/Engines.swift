import CoreText
import Foundation
import JavaScriptCore

/// Formulas through MathJax and diagrams through pele, run in JavaScriptCore (no WebKit), their SVG turned into native
/// paths (guideline 5.3, 5.8). A few engines, each its own JSVirtualMachine, serve callers on any thread; results are
/// kept by input, so a formula is converted once however often it is drawn, in whatever theme or zoom. The app needs
/// the com.apple.security.cs.allow-jit entitlement for JavaScriptCore's JIT (about 4× faster; it works without).
public final class JSEngines: MathTypesetter, DiagramRenderer, @unchecked Sendable {
  /// what text inside formulas and diagrams is measured and drawn with
  public let textFont: [String]
  private let script: String
  private let pool = NSCondition()
  private var idle: [Engine] = []
  private var made = 0
  private let limit: Int
  private let results = Cache<MathKey, MathResult>(limit: 20_000)
  private let diagrams = Cache<DiagramKey, DiagramResult>(limit: 500)

  struct DiagramKey: Hashable {
    let source: String
    let fonts: [String]
    let maxWidth: Int?
  }

  public func diagram(_ source: String, fonts: [String], maxWidth: Int?) -> DiagramResult {
    diagrams.get(DiagramKey(source: source, fonts: fonts, maxWidth: maxWidth)) {
      let e = take()
      defer { give(e) }
      return e.mermaid(source, fonts: fonts, maxWidth: maxWidth)
    }
  }

  struct MathKey: Hashable {
    let latex: String
    let display: Bool
    let preamble: String
  }

  /// script: engines.js of the assets build (apps/macos/web/dist); engines: how many may run at once
  public init(script: URL, engines: Int = 2, textFont: [String] = ["-apple-system", "PingFang SC"]) throws {
    self.script = try String(contentsOf: script, encoding: .utf8)
    limit = max(1, engines)
    self.textFont = textFont
  }

  /// an idle engine, or a new one while under the limit, or the next one to come back
  private func take() -> Engine {
    pool.lock()
    defer { pool.unlock() }
    while true {
      if let e = idle.popLast() { return e }
      if made < limit {
        made += 1
        pool.unlock()
        // made outside the lock: loading the script takes tens of milliseconds
        let e = Engine(script: script, textFont: textFont)
        pool.lock()
        return e
      }
      pool.wait()
    }
  }
  private func give(_ e: Engine) {
    pool.lock()
    idle.append(e)
    pool.signal()
    pool.unlock()
  }

  public func typeset(_ latex: String, display: Bool, preamble: String) -> MathResult {
    results.get(MathKey(latex: latex, display: display, preamble: preamble)) {
      let e = take()
      defer { give(e) }
      return e.tex(latex, display: display, preamble: preamble)
    }
  }

  /// converts these formulas now, so later drawing finds them ready (opening a vault, say)
  public func prepare(_ formulas: [(latex: String, display: Bool)], preamble: String) async {
    await withTaskGroup(of: Void.self) { g in
      for f in formulas { g.addTask { _ = self.typeset(f.latex, display: f.display, preamble: preamble) } }
    }
  }
}

/// One JavaScriptCore context with the engines script loaded
private final class Engine {
  let context: JSContext
  let textFont: [String]
  /// what the next measurement is made in: the formula font, or a diagram's
  var measuring: [String]

  init(script: String, textFont: [String]) {
    self.textFont = textFont
    measuring = textFont
    context = JSContext(virtualMachine: JSVirtualMachine())!
    context.evaluateScript("var console = { log() {}, warn() {}, error() {}, info() {} };")
    let measure: @convention(block) (String, Double) -> Double = { [unowned self] text, size in
      let f = FontBook.font(self.measuring, size: CGFloat(size))
      let line = CTLineCreateWithAttributedString(
        NSAttributedString(string: text, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): f]))
      return CTLineGetTypographicBounds(line, nil, nil, nil)
    }
    context.setObject(measure, forKeyedSubscript: "measureText" as NSString)
    context.evaluateScript(script)
  }

  func mermaid(_ source: String, fonts: [String], maxWidth: Int?) -> DiagramResult {
    measuring = fonts
    defer { measuring = textFont }
    let args: [Any] = [source, fonts.first ?? "sans-serif", maxWidth.map { $0 as Any } ?? NSNull()]
    guard let engines = context.objectForKeyedSubscript("engines"),
      let r = engines.invokeMethod("mermaid", withArguments: args).toDictionary()
    else { return .error("diagram engine not loaded") }
    if let e = r["error"] as? String { return .error(e) }
    // pele's colours are CSS variables (--_l is its line colour, set from --pele-line): the theme's diagram roles
    let roles = [
      "_bg": "bg", "_fg": "fg", "_m": "muted", "_l": "line", "_s": "surface", "_a": "surfaceAlt", "_b": "border",
      "_c": "accent",
    ]
    let paint: (String) -> MDPath.Paint = { v in
      if v == "none" || v == "transparent" { return .none }
      if v == "currentColor" { return .role("fg") }
      if let m = v.range(of: #"var\(--([\w-]+)"#, options: .regularExpression) {
        let name = String(v[m].dropFirst(6))
        if let r = roles[name] { return .role(r) }
        if name.hasPrefix("pele-") { return .role(String(name.dropFirst(5))) }
      }
      if v.hasPrefix("#") { return .color(MDColor(hex: v)) }
      return .role("fg")
    }
    guard let svg = r["svg"] as? String, let read = SVGImport.read(svg, unit: 1, paint: paint) else {
      return .error("unreadable diagram output")
    }
    return .ok(width: read.box.width, height: read.box.height, paths: read.paths, texts: read.texts)
  }

  func tex(_ latex: String, display: Bool, preamble: String) -> MathResult {
    guard let engines = context.objectForKeyedSubscript("engines"),
      let r = engines.invokeMethod("tex", withArguments: [latex, display, preamble]).toDictionary()
    else { return .error(message: "formula engine not loaded", at: nil, fix: nil) }
    if let e = r["error"] as? String { return .error(message: e, at: nil, fix: nil) }
    guard let svg = r["svg"] as? String,
      let read = SVGImport.read(svg, unit: 0.001, paint: { v in v == "none" ? .none : .ink })
    else { return .error(message: "unreadable formula output", at: nil, fix: nil) }
    let box = read.box
    return .ok(
      MathPicture(
        width: box.width / 1000, height: box.height / 1000, baseline: -box.minY / 1000, paths: read.paths,
        texts: read.texts))
  }
}
