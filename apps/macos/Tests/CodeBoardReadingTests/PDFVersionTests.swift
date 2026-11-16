import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import PDFKit
import Testing

@testable import CodeBoardReading

/// An arXiv paper's entry with versions v5 and v7, each a PDF of two pages, in the fixture's vault
@MainActor struct PaperVault {
  let v: PDFVault
  let path: String
  let entry: Entry

  init(translation: Bool = false) throws {
    v = try PDFVault()
    let paper = ArxivPaper(id: "1706.03762", title: "Attention Is All You Need", authors: [], year: 2017, latest: 7)
    var (e, path) = try v.vault.newEntry(
      paper, version: 5, pdf: makePDF(["Five one", "Five two"]), in: v.resource.path)
    let seven = try v.vault.addEntryFile(makePDF(["Seven one", "Seven two"]), named: "1706.03762v7.pdf", to: path)
    e.versions.append(
      Version(id: VersionID(rawValue: "v7"), label: "v7", added: 1, language: "en", content: .pdf(file: seven)))
    if translation {
      let zh = try v.vault.addEntryFile(makePDF(["七 一", "七 二"]), named: "1706.03762v7.zh.pdf", to: path)
      e.versions.append(
        Version(
          id: VersionID(rawValue: "zh"), label: "v7 中文", added: 2, language: "zh", of: VersionID(rawValue: "v7"),
          content: .pdf(file: zh)))
    }
    try v.vault.write(e, at: path)
    self.path = path
    entry = e
  }
}

/// Answers the arXiv API as if `latest` were the paper's newest version, and any PDF
func fakeArxiv(latest: Int) -> Arxiv {
  Arxiv { req in
    let url = req.url!.absoluteString
    let body =
      url.contains("api/query")
      ? "<feed xmlns=\"http://www.w3.org/2005/Atom\"><entry><id>http://arxiv.org/abs/1706.03762v\(latest)</id>"
        + "<published>2017-06-12T17:57:34Z</published><title>Attention Is All You Need</title></entry></feed>"
      : "%PDF-1.4 v\(latest)"
    return (Data(body.utf8), HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
  }
}

// A PDF tab's versions bar: when it shows, switching versions in the same tab, "+ 译文", the job's item, Check for New
// Version
@MainActor @Suite(.serialized) struct PDFVersionTests {
  @Test func aPlainPDFShowsNoBarAndAPapersBarHasASegmentPerVersionAtTheBottomMiddle() throws {
    let p = try PaperVault()
    defer { p.v.remove() }
    let w = try PDFWindow(p.v)
    defer { w.close() }
    let plain = try w.tab(try #require(w.pane.openPDF(.file(p.v.file))))
    #expect(plain.versions.isHidden)
    let t = try w.tab(try #require(w.pane.openPDF(.entry(p.entry.id, version: VersionID(rawValue: "v7")))))
    #expect(!t.versions.isHidden && t.versions.accessibilityIdentifier() == "ui-versionbar")
    #expect(t.versions.segments.map(\.title) == ["v5", "v7"])
    #expect(t.versions.segments.map { $0.accessibilityIdentifier() } == ["ui-version1", "ui-version2"])
    #expect(t.versions.segments.map(\.on) == [false, true])
    #expect(t.versions.translate == nil, "no translations on this machine")
    let look = w.pane.barLook
    #expect(t.versions.frame.height == look.height && t.versions.frame.maxY == t.bounds.height - look.bottom)
    #expect(abs(t.versions.frame.midX - t.bounds.midX) <= 0.5)
    #expect(t.versionsMenu().items.map(\.title) == ["Check for New Version"])
    // the theme changes: so does the bar
    w.pane.barLook = .inkWash(dark: true)
    w.paneView.sync()
    t.layoutSubtreeIfNeeded()
    #expect(t.versions.frame.height == 46)
  }

  @Test func aSegmentShowsItsVersionInTheSameTabAndATranslationKeepsThePage() throws {
    let p = try PaperVault(translation: true)
    defer { p.v.remove() }
    let w = try PDFWindow(p.v)
    defer { w.close() }
    let id = try #require(w.pane.openPDF(.entry(p.entry.id, version: VersionID(rawValue: "v7"))))
    let t = try w.tab(id)
    #expect(t.versions.segments.map(\.title) == ["v5", "v7", "v7 中文"])
    t.pdf.go(to: try #require(t.pdf.document?.page(at: 1)))
    t.versions.segments[2].performClick(nil)
    #expect(t.pdf.document?.page(at: 0)?.string == "七 一")
    #expect(t.pdf.currentPage.flatMap { t.pdf.document?.index(for: $0) } == 1, "the same page of the translation")
    #expect(w.pane.tabs.count == 1 && w.pane.tabs[0].payload["version"] == "zh")
    #expect(w.pane.tabs[0].key == PDFTarget.entry(p.entry.id, version: VersionID(rawValue: "zh")).key)
    #expect(t.versions.segments.map(\.on) == [false, false, true])
    #expect(t.versions.translate == nil, "it is a translation")
    t.versions.segments[0].performClick(nil)
    #expect(t.pdf.document?.page(at: 0)?.string == "Five one")
    #expect(w.pane.tabs[0].payload["version"] == p.entry.versions[0].id.rawValue)
  }

  @Test func translatingIsAskedFromTheBarAndAFailureShowsWhyWithRetry() async throws {
    let p = try PaperVault()
    defer { p.v.remove() }
    let machine = FileManager.default.temporaryDirectory.appending(path: "machine-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: machine) }
    // a tongtu whose doctor fails at once
    let queue = Translations(folder: machine, tongtu: { URL(filePath: "/usr/bin/false") }, poll: .milliseconds(20))
    let w = try PDFWindow(p.v)
    defer { w.close() }
    w.pane.translations = queue
    let t = try w.tab(try #require(w.pane.openPDF(.entry(p.entry.id, version: VersionID(rawValue: "v7")))))
    let translate = try #require(t.versions.translate)
    #expect(translate.accessibilityIdentifier() == "ui-versiontranslate" && translate.isEnabled)
    // an action, lighter than the version shown: the bar's ink faded, not bold
    let ink = { (b: NSButton) in b.attributedTitle.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor }
    #expect((ink(translate)?.alphaComponent ?? 1) < (ink(t.versions.segments[1])?.alphaComponent ?? 0))
    translate.performClick(nil)
    let job = try #require(queue.jobs.first)
    #expect(job.paper == "1706.03762v7" && job.label == "v7 中文" && job.version == VersionID(rawValue: "v7"))
    await queue.settled()
    t.layoutSubtreeIfNeeded()
    let item = try #require(t.versions.job)
    #expect(item.accessibilityIdentifier() == "ui-versionjob" && item.title == "译文 · failed")
    #expect(t.versions.translate == nil)
    // red from the moment it fails, before any hover or press
    #expect(item.layer?.backgroundColor == NSColor.systemRed.withAlphaComponent(0.14).cgColor)
    item.performClick(nil)
    #expect(!t.note.isHidden && t.note.text.stringValue.hasPrefix("tongtu doctor:"))
    #expect(t.note.button.accessibilityIdentifier() == "ui-versionretry")
    t.note.button.performClick(nil)
    #expect(t.note.isHidden)
    #expect(queue.state(of: job) != nil)
    await queue.settled()
    // without tongtu "+ 译文" is there but off, saying why
    queue.cancel(job)
    queue.tongtu = { nil }
    t.reread()
    #expect(t.versions.translate?.isEnabled == false && t.versions.translate?.toolTip == queue.missing)
  }

  @Test func checkForNewVersionAddsOneMoreVersionOnlyWhenArxivHasANewerOne() async throws {
    let p = try PaperVault()
    defer { p.v.remove() }
    let w = try PDFWindow(p.v)
    defer { w.close() }
    let t = try w.tab(try #require(w.pane.openPDF(.entry(p.entry.id, version: VersionID(rawValue: "v7")))))
    w.pane.arxiv = fakeArxiv(latest: 7)
    await t.checkForNewVersion()?.value
    #expect(t.versions.segments.count == 2 && t.note.text.stringValue == "v7 is the newest version on arXiv.")
    w.pane.arxiv = fakeArxiv(latest: 8)
    await t.checkForNewVersion()?.value
    #expect(t.versions.segments.map(\.title) == ["v5", "v7", "v8"])
    #expect(try p.v.vault.entry(at: p.path).versions.map(\.label) == ["v5", "v7", "v8"])
    #expect(w.pane.tabs[0].payload["version"] == "v7", "the tab stays on what it showed")
  }
}
