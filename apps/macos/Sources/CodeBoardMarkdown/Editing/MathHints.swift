import Foundation

/// One formula command the editor offers while a TeX command is typed (editor/mathhints.ts MathCmd): `snip` is what is
/// written, its | where the caret goes; `preview` is typeset to show it
public struct MDMathCommand: Sendable, Equatable {
  public enum Origin: String, Sendable, Equatable { case builtIn, preamble, sameFormula }
  public var name: String
  public var snip: String
  public var preview: String
  public var detail: String
  public var origin: Origin = .builtIn
}

extension MarkdownEditing {
  /// The common KaTeX commands, the first ones first (mathhints.ts MATH_CMDS, the same order and words)
  public static let mathCommands: [MDMathCommand] = [
    .init(name: "frac", snip: "\\frac{|}{}", preview: "\\frac{a}{b}", detail: "分数"),
    .init(name: "times", snip: "\\times ", preview: "a\\times b", detail: "乘号"),
    .init(name: "text", snip: "\\text{|}", preview: "\\text{abc}", detail: "正文字体"),
    .init(name: "sum", snip: "\\sum_{|}^{}", preview: "\\sum_{i=0}^{n}", detail: "求和"),
    .init(name: "cdot", snip: "\\cdot ", preview: "a\\cdot b", detail: "点乘"),
    .init(name: "sqrt", snip: "\\sqrt{|}", preview: "\\sqrt{x}", detail: "根号"),
    .init(name: "lceil", snip: "\\lceil | \\rceil", preview: "\\lceil x\\rceil", detail: "向上取整"),
    .init(name: "lfloor", snip: "\\lfloor | \\rfloor", preview: "\\lfloor x\\rfloor", detail: "向下取整"),
    .init(name: "left", snip: "\\left( | \\right)", preview: "\\left(\\frac{a}{b}\\right)", detail: "自动变大的括号"),
    .init(name: "leq", snip: "\\leq ", preview: "a\\leq b", detail: "小于等于"),
    .init(name: "geq", snip: "\\geq ", preview: "a\\geq b", detail: "大于等于"),
    .init(name: "neq", snip: "\\neq ", preview: "a\\neq b", detail: "不等于"),
    .init(name: "approx", snip: "\\approx ", preview: "a\\approx b", detail: "约等于"),
    .init(name: "in", snip: "\\in ", preview: "i\\in S", detail: "属于"),
    .init(name: "notin", snip: "\\notin ", preview: "i\\notin S", detail: "不属于"),
    .init(name: "infty", snip: "\\infty ", preview: "\\infty", detail: "无穷"),
    .init(name: "to", snip: "\\to ", preview: "a\\to b", detail: "箭头"),
    .init(name: "rightarrow", snip: "\\rightarrow ", preview: "a\\rightarrow b", detail: "右箭头"),
    .init(name: "leftarrow", snip: "\\leftarrow ", preview: "a\\leftarrow b", detail: "左箭头"),
    .init(name: "Rightarrow", snip: "\\Rightarrow ", preview: "A\\Rightarrow B", detail: "推出"),
    .init(name: "iff", snip: "\\iff ", preview: "A\\iff B", detail: "当且仅当"),
    .init(name: "mapsto", snip: "\\mapsto ", preview: "x\\mapsto y", detail: "映射到"),
    .init(name: "ldots", snip: "\\ldots ", preview: "1,\\ldots,n", detail: "省略号"),
    .init(name: "cdots", snip: "\\cdots ", preview: "a+\\cdots+b", detail: "居中省略号"),
    .init(name: "log", snip: "\\log ", preview: "\\log n", detail: "对数"),
    .init(name: "ln", snip: "\\ln ", preview: "\\ln x", detail: "自然对数"),
    .init(name: "exp", snip: "\\exp ", preview: "\\exp x", detail: "指数"),
    .init(name: "sin", snip: "\\sin ", preview: "\\sin x", detail: "正弦"),
    .init(name: "cos", snip: "\\cos ", preview: "\\cos x", detail: "余弦"),
    .init(name: "max", snip: "\\max ", preview: "\\max(a,b)", detail: "最大值"),
    .init(name: "min", snip: "\\min ", preview: "\\min(a,b)", detail: "最小值"),
    .init(name: "lim", snip: "\\lim_{|}", preview: "\\lim_{n\\to\\infty}", detail: "极限"),
    .init(name: "prod", snip: "\\prod_{|}^{}", preview: "\\prod_{i}", detail: "连乘"),
    .init(name: "int", snip: "\\int_{|}^{}", preview: "\\int_a^b", detail: "积分"),
    .init(name: "partial", snip: "\\partial ", preview: "\\partial f", detail: "偏导"),
    .init(name: "nabla", snip: "\\nabla ", preview: "\\nabla f", detail: "梯度"),
    .init(name: "alpha", snip: "\\alpha ", preview: "\\alpha", detail: "希腊字母 α"),
    .init(name: "beta", snip: "\\beta ", preview: "\\beta", detail: "希腊字母 β"),
    .init(name: "gamma", snip: "\\gamma ", preview: "\\gamma", detail: "希腊字母 γ"),
    .init(name: "delta", snip: "\\delta ", preview: "\\delta", detail: "希腊字母 δ"),
    .init(name: "epsilon", snip: "\\epsilon ", preview: "\\epsilon", detail: "希腊字母 ε"),
    .init(name: "eta", snip: "\\eta ", preview: "\\eta", detail: "希腊字母 η"),
    .init(name: "theta", snip: "\\theta ", preview: "\\theta", detail: "希腊字母 θ"),
    .init(name: "lambda", snip: "\\lambda ", preview: "\\lambda", detail: "希腊字母 λ"),
    .init(name: "mu", snip: "\\mu ", preview: "\\mu", detail: "希腊字母 μ"),
    .init(name: "pi", snip: "\\pi ", preview: "\\pi", detail: "希腊字母 π"),
    .init(name: "rho", snip: "\\rho ", preview: "\\rho", detail: "希腊字母 ρ"),
    .init(name: "sigma", snip: "\\sigma ", preview: "\\sigma", detail: "希腊字母 σ"),
    .init(name: "tau", snip: "\\tau ", preview: "\\tau", detail: "希腊字母 τ"),
    .init(name: "phi", snip: "\\phi ", preview: "\\phi", detail: "希腊字母 φ"),
    .init(name: "omega", snip: "\\omega ", preview: "\\omega", detail: "希腊字母 ω"),
    .init(name: "Delta", snip: "\\Delta ", preview: "\\Delta", detail: "大写 Δ"),
    .init(name: "Sigma", snip: "\\Sigma ", preview: "\\Sigma", detail: "大写 Σ"),
    .init(name: "Omega", snip: "\\Omega ", preview: "\\Omega", detail: "大写 Ω"),
    .init(name: "mathbf", snip: "\\mathbf{|}", preview: "\\mathbf{x}", detail: "粗体"),
    .init(name: "mathbb", snip: "\\mathbb{|}", preview: "\\mathbb{R}", detail: "黑板粗体"),
    .init(name: "mathrm", snip: "\\mathrm{|}", preview: "\\mathrm{d}x", detail: "直立字体"),
    .init(name: "mathcal", snip: "\\mathcal{|}", preview: "\\mathcal{O}", detail: "花体"),
    .init(name: "operatorname", snip: "\\operatorname{|}", preview: "\\operatorname{ceil}(x)", detail: "自定义函数名"),
    .init(name: "hat", snip: "\\hat{|}", preview: "\\hat{x}", detail: "帽子"),
    .init(name: "bar", snip: "\\bar{|}", preview: "\\bar{x}", detail: "上横线"),
    .init(name: "tilde", snip: "\\tilde{|}", preview: "\\tilde{x}", detail: "波浪线"),
    .init(name: "vec", snip: "\\vec{|}", preview: "\\vec{v}", detail: "向量"),
    .init(name: "overline", snip: "\\overline{|}", preview: "\\overline{AB}", detail: "长上横线"),
    .init(name: "underbrace", snip: "\\underbrace{|}_{}", preview: "\\underbrace{a+b}_{n}", detail: "下大括号"),
    .init(name: "binom", snip: "\\binom{|}{}", preview: "\\binom{n}{k}", detail: "组合数"),
    .init(name: "bmod", snip: "\\bmod ", preview: "a\\bmod b", detail: "取模"),
    .init(name: "pm", snip: "\\pm ", preview: "\\pm 1", detail: "正负号"),
    .init(name: "div", snip: "\\div ", preview: "a\\div b", detail: "除号"),
    .init(name: "equiv", snip: "\\equiv ", preview: "a\\equiv b", detail: "恒等 / 同余"),
    .init(name: "sim", snip: "\\sim ", preview: "X\\sim N", detail: "相似 / 服从"),
    .init(name: "propto", snip: "\\propto ", preview: "y\\propto x", detail: "正比于"),
    .init(name: "ll", snip: "\\ll ", preview: "a\\ll b", detail: "远小于"),
    .init(name: "gg", snip: "\\gg ", preview: "a\\gg b", detail: "远大于"),
    .init(name: "forall", snip: "\\forall ", preview: "\\forall x", detail: "任意"),
    .init(name: "exists", snip: "\\exists ", preview: "\\exists x", detail: "存在"),
    .init(name: "cup", snip: "\\cup ", preview: "A\\cup B", detail: "并集"),
    .init(name: "cap", snip: "\\cap ", preview: "A\\cap B", detail: "交集"),
    .init(name: "subseteq", snip: "\\subseteq ", preview: "A\\subseteq B", detail: "子集"),
    .init(name: "emptyset", snip: "\\emptyset ", preview: "\\emptyset", detail: "空集"),
    .init(name: "top", snip: "\\top ", preview: "A^\\top", detail: "转置"),
    .init(name: "circ", snip: "\\circ ", preview: "f\\circ g", detail: "复合"),
    .init(name: "oplus", snip: "\\oplus ", preview: "a\\oplus b", detail: "异或 / 直和"),
    .init(name: "otimes", snip: "\\otimes ", preview: "a\\otimes b", detail: "张量积"),
    .init(name: "langle", snip: "\\langle | \\rangle", preview: "\\langle a,b\\rangle", detail: "尖括号 / 内积"),
    .init(name: "lVert", snip: "\\lVert | \\rVert", preview: "\\lVert x\\rVert", detail: "范数"),
    .init(
      name: "begin", snip: "\\begin{cases} | & \\\\  & \\end{cases}",
      preview: "\\begin{cases}a&x>0\\\\b&x\\le 0\\end{cases}", detail: "分情况"),
    .init(
      name: "pmatrix", snip: "\\begin{pmatrix} | & \\\\  & \\end{pmatrix}",
      preview: "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}", detail: "矩阵"),
  ]

  /// The command being typed before the caret in a formula's TeX: the letters after a \ (a \\ is a line break, not
  /// one), and where its \ is (mathhints.ts tokenAt)
  public static func mathToken(_ tex: String, caret: Int) -> (query: String, from: Int)? {
    let u = Array(tex.utf16.prefix(caret))
    var i = u.count
    while i > 0, let s = Unicode.Scalar(u[i - 1]), CharacterSet.letters.contains(s), s.isASCII { i -= 1 }
    guard i > 0, u[i - 1] == 0x5C else { return nil }
    var k = 0
    var j = i - 2
    while j >= 0, u[j] == 0x5C {
      k += 1
      j -= 1
    }
    guard k % 2 == 0 else { return nil }
    return (String(decoding: u[i..<u.count], as: UTF16.self), i - 1)
  }

  /// The commands defined by \newcommand, \renewcommand or \def in a TeX source: name, how many arguments, body
  public static func mathDefinitions(_ tex: String) -> [(name: String, args: Int, body: String)] {
    var out: [(String, Int, String)] = []
    let ns = tex as NSString
    let re = try! NSRegularExpression(
      pattern:
        #"\\(?:re)?newcommand\s*\{?\\([A-Za-z]+)\}?\s*(?:\[(\d)\])?\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}|\\def\s*\\([A-Za-z]+)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}"#
    )
    for m in re.matches(in: tex, range: NSRange(location: 0, length: ns.length)) {
      func g(_ i: Int) -> String? { m.range(at: i).location == NSNotFound ? nil : ns.substring(with: m.range(at: i)) }
      if let n = g(1) {
        out.append((n, Int(g(2) ?? "0") ?? 0, g(3) ?? ""))
      } else if let n = g(4) {
        out.append((n, 0, g(5) ?? ""))
      }
    }
    return out
  }

  /// What \query lists (mathhints.ts completions): the preamble's commands and the formula's own first, then the common
  /// ones; names starting with the query first (case first), then those holding it; at most eight. Nothing once a
  /// command without arguments is typed in full
  public static func mathCompletions(_ query: String, tex: String, preamble: String) -> [MDMathCommand] {
    func user(_ d: (name: String, args: Int, body: String), _ o: MDMathCommand.Origin) -> MDMathCommand {
      let xs = ["{x}", "{y}", "{z}", "{w}"]
      return MDMathCommand(
        name: d.name, snip: "\\" + d.name + (d.args > 0 ? "{|}" + String(repeating: "{}", count: d.args - 1) : " "),
        preview: "\\" + d.name + xs.prefix(d.args).joined() + String(repeating: "{}", count: max(0, d.args - 4)),
        detail: d.body.count > 26 ? String(d.body.prefix(25)) + "…" : d.body, origin: o)
    }
    let pre = mathDefinitions(preamble).map { user($0, .preamble) }
    let own = mathDefinitions(tex).filter { d in !pre.contains { $0.name == d.name } }.map { user($0, .sameFormula) }
    let users = pre + own
    let all = users + mathCommands
    if query.isEmpty { return Array(all.prefix(max(8, users.count))) }
    let l = query.lowercased()
    let head = all.filter { $0.name.hasPrefix(query) }
    let headI = all.filter { !$0.name.hasPrefix(query) && $0.name.lowercased().hasPrefix(l) }
    let mid = all.filter { !$0.name.lowercased().hasPrefix(l) && $0.name.lowercased().contains(l) }
    if head.count == 1, head[0].name == query, !head[0].snip.contains("{") { return [] }
    return Array((head + headI + mid).prefix(8))
  }
}

/// What is wrong with a formula, in plain words (mathhints.ts MathProblem): text, source (in the code font) and one-click
/// fixes (a range of the TeX and what to write there); `at`, where in the TeX the problem is, when known
public struct MDMathProblem: Sendable, Equatable {
  public enum Part: Sendable, Equatable {
    case text(String)
    case code(String)
    case fix(label: String, range: Range<Int>, text: String)
  }
  public var parts: [Part]
  public var at: Int?
}

extension MarkdownEditing {
  /// a TeX's braces: how many are still open at its end, and where the first one closes nothing (-1: none)
  static func braces(_ tex: String) -> (open: Int, extra: Int) {
    let u = Array(tex.utf16)
    var open = 0
    var extra = -1
    var i = 0
    while i < u.count {
      let ch = u[i]
      if ch == 0x5C {
        i += 2
        continue
      }
      if ch == 0x7B {
        open += 1
      } else if ch == 0x7D {
        if open > 0 { open -= 1 } else if extra < 0 { extra = i }
      }
      i += 1
    }
    return (open, extra)
  }

  /// the known command nearest a misspelt name, two edits away at most (mathhints.ts nearest)
  static func nearestCommand(_ name: String, tex: String, preamble: String) -> String? {
    func lev(_ a: [Character], _ b: [Character]) -> Int {
      var prev = Array(0...b.count)
      for (i, x) in a.enumerated() {
        var cur = [i + 1]
        for (j, y) in b.enumerated() { cur.append(min(prev[j + 1] + 1, cur[j] + 1, prev[j] + (x == y ? 0 : 1))) }
        prev = cur
      }
      return prev[b.count]
    }
    let names = mathDefinitions(preamble).map(\.name) + mathDefinitions(tex).map(\.name) + mathCommands.map(\.name)
    var best: String?
    var bd = 3
    for n in names {
      let d = lev(Array(name), Array(n))
      if d < bd {
        bd = d
        best = n
      }
    }
    return best
  }

  /// Whether a TeX that does not typeset is only a command name being typed (the caret at its end and longer names start
  /// with it): no error is shown for it yet (mathhints.ts checkMath)
  public static func typingCommand(_ tex: String, caret: Int, preamble: String) -> Bool {
    guard let t = mathToken(tex, caret: caret), !t.query.isEmpty else { return false }
    let ns = tex as NSString
    if caret < ns.length, let c = Unicode.Scalar(ns.character(at: caret)), CharacterSet.letters.contains(c) {
      return false
    }
    let names = mathDefinitions(preamble).map(\.name) + mathDefinitions(tex).map(\.name) + mathCommands.map(\.name)
    return names.contains { $0.hasPrefix(t.query) && $0 != t.query }
  }

  /// MathJax's message for a TeX that does not typeset, said as mathhints.ts says KaTeX's: what is wrong, and a fix when
  /// one is sure (the nearest command, a missing or extra brace, \renewcommand)
  public static func explainMath(_ message: String, tex: String, preamble: String) -> MDMathProblem {
    let ns = tex as NSString
    let b = braces(tex)
    func match(_ p: String) -> [String]? {
      guard let re = try? NSRegularExpression(pattern: p, options: [.caseInsensitive]),
        let m = re.firstMatch(in: message, range: NSRange(location: 0, length: (message as NSString).length))
      else { return nil }
      return (0..<m.numberOfRanges).map {
        m.range(at: $0).location == NSNotFound ? "" : (message as NSString).substring(with: m.range(at: $0))
      }
    }
    var parts: [MDMathProblem.Part] = []
    var at: Int?
    if let m = match(#"Undefined control sequence (\\[A-Za-z]+)"#) {
      let name = m[1]
      parts = [.text("不认识 "), .code(name), .text(" 这个命令。")]
      let from = ns.range(of: name).location
      let next = from == NSNotFound ? nil : NSMaxRange(ns.range(of: name))
      let followedByLetter =
        next.map { $0 < ns.length && CharacterSet.letters.contains(Unicode.Scalar(ns.character(at: $0)) ?? " ") }
        ?? true
      if from != NSNotFound, !followedByLetter,
        let best = nearestCommand(String(name.dropFirst()), tex: tex, preamble: preamble)
      {
        at = from
        let len = (name as NSString).length
        parts += [
          .text(" 是不是想写 "), .fix(label: "\\" + best, range: from..<(from + len), text: "\\" + best), .text("？"),
        ]
      }
    } else if let m = match(#"(\\[A-Za-z]+) already defined"#) ?? match(#"redefine (\\[A-Za-z]+)"#) {
      let from = ns.range(of: "\\newcommand").location
      parts = [
        .code(m[1]), .text(" 已经有了（公式预设里定义过，或是自带的）；要在这个公式里改写它，用 "), .code("\\renewcommand"), .text("。"),
      ]
      if from != NSNotFound {
        at = from
        parts += [.text(" "), .fix(label: "改成 \\renewcommand", range: from..<(from + 11), text: "\\renewcommand")]
      }
    } else if b.open > 0, match("Missing close brace|end of input") != nil {
      at = ns.length
      parts = [
        .text("少了一个 "), .code("}"), .text("：前面有个 "), .code("{"), .text(" 没配上。 "),
        .fix(label: "补上 }", range: ns.length..<ns.length, text: "}"),
      ]
    } else if b.extra >= 0 {
      at = b.extra
      parts = [
        .text("多了一个 "), .code("}"), .text("，删掉它，或在前面补上 "), .code("{"), .text("。 "),
        .fix(label: "删掉 }", range: b.extra..<(b.extra + 1), text: ""),
      ]
    } else if match("Double subscripts") != nil {
      parts = [
        .text("同一个字母只能有一个下标："), .code("x_i_j"), .text(" 要写成 "), .code("x_{ij}"), .text(" 或 "), .code("x_{i_j}"),
        .text("。"),
      ]
    } else if match("Double exponent") != nil {
      parts = [.text("同一个字母只能有一个上标："), .code("x^a^b"), .text(" 要写成 "), .code("x^{ab}"), .text("。")]
    } else if match("Missing superscript or subscript argument") != nil {
      parts = [.code("^"), .text(" 或 "), .code("_"), .text(" 后面还没写东西。")]
    } else if let m = match(#"Missing argument for (\\[A-Za-z]+)"#) {
      parts = [.code(m[1]), .text(" 后面要跟 "), .code("{…}"), .text("。")]
    } else if match(#"\\right|\\left"#) != nil {
      parts = [.code("\\left"), .text(" 要和 "), .code("\\right"), .text(" 成对出现。")]
    } else if match(#"\\begin\{[^}]*\} ended with|Missing \\end"#) != nil {
      parts = [.code("\\begin{…}"), .text(" 少了配对的 "), .code("\\end{…}"), .text("。")]
    } else if match("Misplaced &") != nil {
      parts = [.code("&"), .text(" 只能用在矩阵、"), .code("cases"), .text("、"), .code("aligned"), .text(" 这类环境里。")]
    } else {
      parts = [.text("排不出来："), .text(message)]
    }
    return MDMathProblem(parts: parts, at: at.map { min($0, ns.length) })
  }
}
