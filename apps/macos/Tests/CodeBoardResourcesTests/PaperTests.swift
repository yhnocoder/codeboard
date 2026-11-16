import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardResources

/// A made-up paper's TeX, line by line as the block list below numbers it
let paperTeX = #"""
  \documentclass{article}
  \newcommand{\R}{\mathbb{R}}
  \DeclareMathOperator*{\argmax}{arg\,max}
  \def\vx#1{\mathbf{x}_{#1}} % a vector
  \begin{document}
  \begin{abstract}
  We study rivers.
  \end{abstract}
  \section{Intro}
  The river runs \emph{north} past the \textbf{mill}~today.
  Birds rest (\ref{eq:e}) at 5\% of the bank.
  \begin{equation}
  E = mc^2 \label{eq:e}
  \end{equation}
  \begin{figure}
  \caption{A boat.}
  \end{figure}
  \subsection{Detail}
  Evening light \(x\) falls.
  \begin{align}
  a &= b \\
  c &= d \nonumber \\
  e &= f
  \end{align}
  \[ y = 1 \]
  \begin{table}
  \caption{Numbers.}
  \end{table}
  \appendix
  \section{Proofs}
  More text.
  \end{document}
  """#

/// Its block list as tongtu writes one: page 1 from the abstract to the figure, page 2 the rest
let paperAnchors = """
  {"pdf": "p.zh.pdf", "tex": "zh.tex", "pages": [{"page": 1, "width": 300, "height": 400, "body": null}],
   "blocks": [
    {"id": "CAP-9", "kind": "abstract", "parent": null, "first_line": 6, "last_line": 8,
     "rects": [{"page": 1, "x0": 20, "y0": 380, "x1": 280, "y1": 395}]},
    {"id": "PAR-1-0", "kind": "heading", "parent": null, "first_line": 9, "last_line": 9,
     "rects": [{"page": 1, "x0": 20, "y0": 360, "x1": 280, "y1": 375}]},
    {"id": "PAR-2-0", "kind": "text", "parent": null, "first_line": 10, "last_line": 11,
     "rects": [{"page": 1, "x0": 20, "y0": 320, "x1": 280, "y1": 355}]},
    {"id": "BLK-0", "kind": "math", "parent": null, "first_line": 12, "last_line": 14,
     "rects": [{"page": 1, "x0": 60, "y0": 290, "x1": 240, "y1": 310}]},
    {"id": "BLK-1", "kind": "figure", "parent": null, "first_line": 15, "last_line": 17,
     "rects": [{"page": 1, "x0": 40, "y0": 200, "x1": 260, "y1": 280}]},
    {"id": "CAP-0", "kind": "caption", "parent": "BLK-1", "first_line": 16, "last_line": 16,
     "rects": [{"page": 1, "x0": 40, "y0": 200, "x1": 260, "y1": 215}]},
    {"id": "PAR-3-0", "kind": "heading", "parent": null, "first_line": 18, "last_line": 18,
     "rects": [{"page": 2, "x0": 20, "y0": 360, "x1": 280, "y1": 375}]},
    {"id": "PAR-4-0", "kind": "text", "parent": null, "first_line": 19, "last_line": 19,
     "rects": [{"page": 2, "x0": 20, "y0": 340, "x1": 280, "y1": 355}]},
    {"id": "BLK-2", "kind": "math", "parent": null, "first_line": 20, "last_line": 24,
     "rects": [{"page": 2, "x0": 60, "y0": 280, "x1": 240, "y1": 330}]},
    {"id": "BLK-3", "kind": "math", "parent": null, "first_line": 25, "last_line": 25,
     "rects": [{"page": 2, "x0": 60, "y0": 250, "x1": 240, "y1": 270}]},
    {"id": "BLK-4", "kind": "table", "parent": null, "first_line": 26, "last_line": 28,
     "rects": [{"page": 2, "x0": 40, "y0": 150, "x1": 260, "y1": 240}]},
    {"id": "CAP-1", "kind": "caption", "parent": "BLK-4", "first_line": 27, "last_line": 27,
     "rects": [{"page": 2, "x0": 40, "y0": 225, "x1": 260, "y1": 240}]},
    {"id": "PAR-5-0", "kind": "text", "parent": null, "first_line": 29, "last_line": 29, "rects": []},
    {"id": "PAR-6-0", "kind": "heading", "parent": null, "first_line": 30, "last_line": 30,
     "rects": [{"page": 2, "x0": 20, "y0": 120, "x1": 280, "y1": 135}]},
    {"id": "PAR-7-0", "kind": "text", "parent": null, "first_line": 31, "last_line": 31,
     "rects": [{"page": 2, "x0": 20, "y0": 100, "x1": 280, "y1": 115}]}
   ]}
  """

func samplePaper(source: String? = paperTeX) throws -> Paper {
  Paper(list: try JSONDecoder().decode(BlockList.self, from: Data(paperAnchors.utf8)), source: source)
}

@Suite struct PaperTests {
  @Test func theBlockListIsReadAsTongtuWritesItAndABlocksTextIsItsLines() throws {
    let p = try samplePaper()
    #expect(p.list.blocks.count == 15 && p.list.tex == "zh.tex")
    let b = try #require(p.block("BLK-1"))
    #expect(b.kind == "figure" && b.firstLine == 15 && b.lastLine == 17 && b.isObject)
    #expect(b.union(on: 1) == CGRect(x: 40, y: 200, width: 220, height: 80) && b.union(on: 2) == nil)
    #expect(p.text(b) == "\\begin{figure}\n\\caption{A boat.}\n\\end{figure}")
    #expect(try samplePaper(source: nil).text(b) == nil)
  }

  @Test func aPointIsTheObjectThereElseTheSmallestBlockAndALinkGoesToTheBlockBelow() throws {
    let p = try samplePaper()
    #expect(p.block(at: CGPoint(x: 100, y: 205), page: 1)?.id == "BLK-1", "a caption is its figure's")
    #expect(p.block(at: CGPoint(x: 100, y: 300), page: 1)?.id == "BLK-0")
    #expect(p.block(at: CGPoint(x: 100, y: 330), page: 1)?.id == "PAR-2-0")
    #expect(p.block(at: CGPoint(x: 100, y: 180), page: 1) == nil, "blank")
    #expect(p.block(at: CGPoint(x: 100, y: 335), page: 2) == nil)
    #expect(p.target(of: CGPoint(x: 30, y: 358), page: 1)?.id == "PAR-2-0")
    #expect(p.target(of: CGPoint(x: 30, y: 285), page: 1)?.id == "BLK-1")
    #expect(p.target(of: CGPoint(x: 30, y: 245), page: 2)?.id == "BLK-4")
  }

  @Test func thePapersOwnNumbersAreCountedFromItsTeX() throws {
    let p = try samplePaper()
    #expect(
      p.labels == [
        "CAP-9": "摘要", "PAR-1-0": "§ 1", "PAR-2-0": "§ 1", "BLK-0": "式 (1)", "BLK-1": "图 1", "CAP-0": "图 1",
        "PAR-3-0": "§ 1.1", "PAR-4-0": "§ 1.1", "BLK-2": "式 (2)–(3)", "BLK-3": "§ 1.1", "BLK-4": "表 1",
        "CAP-1": "表 1", "PAR-5-0": "§ 1.1", "PAR-6-0": "附录 A", "PAR-7-0": "附录 A",
      ])
    // without the TeX only figures and tables
    #expect(
      try samplePaper(source: nil).labels == [
        "CAP-9": "摘要", "BLK-1": "图 1", "CAP-0": "图 1", "BLK-4": "表 1", "CAP-1": "表 1",
      ])
    // IEEEtran's style
    let ieee = try samplePaper(
      source: paperTeX.replacing("\\documentclass{article}", with: "\\documentclass[conference]{IEEEtran}"))
    #expect(ieee.labels["PAR-4-0"] == "§ I-A" && ieee.labels["BLK-4"] == "表 I" && ieee.labels["PAR-2-0"] == "§ I")
    #expect(Numbering.equationNumbers("\\begin{equation}x\\tag{A1}\\end{equation}").tag == "A1")
    #expect(Numbering.equationNumbers("\\begin{equation*}x\\end{equation*}").count == 0)
  }

  @Test func aSelectionsSpanInTheBlocksTeXIsFoundByItsEndsOrNotAtAll() throws {
    let p = try samplePaper()
    let text = try #require(p.text(p.block("PAR-2-0")!))
    func span(_ selected: String) -> String? {
      Spans.range(of: selected, in: text).map { String(utf16Slice(text, $0)) }
    }
    #expect(span("runs north past") == "runs \\emph{north} past")
    #expect(span("north") == "\\emph{north}", "a whole argument takes its command")
    #expect(span("the mill today. Birds") == "the \\textbf{mill}~today.\nBirds")
    #expect(
      span("Birds rest (1) at 5% of the") == "Birds rest (\\ref{eq:e}) at 5\\% of the", "the ends found, the middle not"
    )
    #expect(span("nowhere to be found") == nil)
    #expect(Spans.range(of: "ab", in: "ab ab ab") == nil, "an end found twice")
    // and back: the PDF's characters a span of the TeX prints
    let pdf = "The river runs north past the mill today. Birds rest (1) at 5% of the bank."
    let at = (text as NSString).range(of: "at 5\\% of the bank.")
    let r = try #require(Spans.range(of: at.location..<(at.location + at.length), in: text, pdf: pdf))
    #expect(String(utf16Slice(pdf, r)) == "at 5% of the bank.")
  }

  @Test func aBlocksTeXAsMarkdownAndAsAFormula() throws {
    let p = try samplePaper()
    let par = try #require(p.block("PAR-2-0"))
    let r = (try #require(p.text(par)) as NSString).range(of: "runs \\emph{north} past")
    let runs = r.location..<(r.location + r.length)
    #expect(
      p.markdown([(par, nil)])
        == "The river runs *north* past the **mill** today.\nBirds rest (\\ref{eq:e}) at 5% of the bank.")
    #expect(
      p.markdown([(p.block("PAR-4-0")!, nil), (par, runs)])
        == "Evening light $x$ falls.\n\nruns *north* past")
    #expect(try samplePaper(source: nil).markdown([(par, nil)]) == nil)
    #expect(p.formula(p.block("BLK-0")!) == "E = mc^2")
    #expect(
      p.formula(p.block("BLK-2")!) == "\\begin{aligned}\na &= b \\\\\nc &= d  \\\\\ne &= f\n\\end{aligned}"
    )
    #expect(p.formula(p.block("BLK-3")!) == "y = 1")
    #expect(p.formula(par) == nil)
  }

  @Test func theAuthorsMacrosComeFromThePreamble() throws {
    #expect(
      try samplePaper().mathPreamble
        == "\\newcommand{\\R}{\\mathbb{R}}\n\\DeclareMathOperator*{\\argmax}{arg\\,max}\n\\def\\vx#1{\\mathbf{x}_{#1}}")
    #expect(Tex.macros("\\begin{document}\\newcommand{\\x}{y}") == nil, "only the preamble")
    #expect(Tex.macros("\\newcommand\\x[1][a]{#1}") == "\\newcommand\\x[1][a]{#1}")
    // a class's internals left out: the engine cannot read them, and would lose what comes after
    #expect(
      Tex.macros(
        "\\makeatletter\\renewcommand{\\float@makebox}{x}\\def\\a@b{y}\\makeatother\\newcommand{\\tr}{\\operatorname{tr}}"
      )
        == "\\newcommand{\\tr}{\\operatorname{tr}}")
    // the bm package's \bm as \boldsymbol, unless the author has one
    #expect(Tex.macros("\\usepackage{amsmath, bm}") == "\\newcommand{\\bm}[1]{\\boldsymbol{#1}}")
    #expect(Tex.macros("\\usepackage{bm}\\newcommand{\\bm}{\\mathbf}") == "\\newcommand{\\bm}{\\mathbf}")
    #expect(Tex.macros("\\usepackage{bbm}") == nil)
  }

  @Test func aSupplementsCountersSubequationsAndAlgorithmsAreNumberedAsPrinted() throws {
    let tex = #"""
      \documentclass[journal]{IEEEtran}
      \begin{document}
      \section{Model}
      \begin{subequations}\label{p}
      \begin{align}
      \min_{\substack{a\\b}} & x \\
      \text{s.t.} & \begin{bmatrix} 1 & 0\\ 0 & 1\end{bmatrix} \succeq 0, \\
      & y \le 1
      \end{align}
      \end{subequations}
      \begin{equation}
      z = 1
      \end{equation}
      \begin{algorithm}
      \caption{Search.}
      \end{algorithm}
      \setcounter{section}{0}
      \renewcommand{\thesection}{S\arabic{section}}
      \setcounter{equation}{0}\renewcommand{\theequation}{S\arabic{equation}}
      \setcounter{figure}{0}
      \renewcommand{\thefigure}{S\arabic{figure}}
      \section{Proofs}
      \begin{equation}
      w = 2
      \end{equation}
      \begin{figure}
      \caption{More.}
      \end{figure}
      \appendices
      \section{Data}
      \end{document}
      """#
    func b(_ id: String, _ kind: String, _ lines: ClosedRange<Int>, parent: String? = nil) -> BlockList.Block {
      BlockList.Block(
        id: id, kind: kind, parent: parent, firstLine: lines.lowerBound, lastLine: lines.upperBound, rects: [])
    }
    // the counters are set between the blocks, in lines no block has
    let p = Paper(
      list: BlockList(blocks: [
        b("H1", "heading", 3...3), b("M1", "math", 4...10), b("M2", "math", 11...13), b("A1", "algorithm", 14...16),
        b("C1", "caption", 15...15, parent: "A1"), b("H2", "heading", 22...22), b("M3", "math", 23...25),
        b("F1", "figure", 26...28), b("C2", "caption", 27...27, parent: "F1"), b("H3", "heading", 30...30),
      ]), source: tex)
    #expect(
      p.labels == [
        "H1": "§ I", "M1": "式 (1a)–(1c)", "M2": "式 (2)", "A1": "算法 1", "C1": "算法 1", "H2": "§ S1", "M3": "式 (S1)",
        "F1": "图 S1", "C2": "图 S1", "H3": "附录 A",
      ])
    let f = try #require(p.formula(p.block("M1")!))
    #expect(f.hasPrefix("\\begin{aligned}\n\\min") && f.hasSuffix("\\end{aligned}") && !f.contains("subequations"))
  }

  @Test func aPointsBlockIsFoundAmongItsPagesOnly() {
    // 30 pages of 12 blocks each, a rect a block
    let blocks = (1...30).flatMap { page in
      (0..<12).map { k in
        BlockList.Block(
          id: "B\(page)-\(k)", kind: "text", firstLine: 1, lastLine: 1,
          rects: [BlockList.Rect(page: page, x0: 20, y0: Double(30 * k), x1: 280, y1: Double(30 * k + 20))])
      }
    }
    let p = Paper(list: BlockList(blocks: blocks), source: nil)
    #expect(
      blocks.allSatisfy { b in p.block(at: CGPoint(x: 100, y: b.rects[0].y0 + 10), page: b.rects[0].page)?.id == b.id })
    #expect(p.block(at: CGPoint(x: 100, y: 25), page: 31) == nil)
    #expect(p.target(of: CGPoint(x: 100, y: 55), page: 7)?.id == "B7-1")
  }

  @Test func aSourceLinesTitleIsCutAtAColonWhenThatKeepsThreeWords() {
    #expect(Paper.shortTitle("Attention Is All You Need") == "Attention Is All You Need")
    #expect(Paper.shortTitle("Deep Residual Learning: For Image Recognition") == "Deep Residual Learning")
    #expect(
      Paper.shortTitle("BERT: Pre-training of Deep Bidirectional Transformers")
        == "BERT: Pre-training of Deep Bidirectional Transformers")
    #expect(Paper.shortTitle("A Long Way Home - Notes") == "A Long Way Home")
  }
}
