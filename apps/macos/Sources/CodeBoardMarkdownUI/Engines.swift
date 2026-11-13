import CoreText
import Foundation
import JavaScriptCore

/// Formulas through MathJax and diagrams through pele, run in JavaScriptCore (no WebKit), their SVG turned into native
/// paths (guideline 5.3, 5.8). A few engines, each its own JSVirtualMachine, serve callers on any thread; results are
/// kept by input, so a formula is converted once however often it is drawn, in whatever theme or zoom. The app needs
/// the com.apple.security.cs.allow-jit entitlement for JavaScriptCore's JIT (about 4× faster; it works without).
public final class JSEngines: MathTypesetter, @unchecked Sendable {
  /// what text inside formulas and diagrams is measured and drawn with
  public let textFont: [String]
  private let script: String
  private let pool = NSCondition()
  private var idle: [Engine] = []
  private var made = 0
  private let limit: Int
  private let results = Cache<MathKey, MathResult>(limit: 20_000)

  struct MathKey: Hashable {
    let latex: String
    let display: Bool
    let preamble: String
  }

  /// script: engines.js of the Note page build (apps/macos/web/dist); engines: how many may run at once
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

  init(script: String, textFont: [String]) {
    self.textFont = textFont
    context = JSContext(virtualMachine: JSVirtualMachine())!
    context.evaluateScript("var console = { log() {}, warn() {}, error() {}, info() {} };")
    let fonts = textFont
    let measure: @convention(block) (String, Double) -> Double = { text, size in
      let f = FontBook.font(fonts, size: CGFloat(size))
      let line = CTLineCreateWithAttributedString(
        NSAttributedString(string: text, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): f]))
      return CTLineGetTypographicBounds(line, nil, nil, nil)
    }
    context.setObject(measure, forKeyedSubscript: "measureText" as NSString)
    context.evaluateScript(script)
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
