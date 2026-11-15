import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardSyntax

/// `--code`: a board made here of heavy code cards (long functions with tabs and long lines, half of them wrapped, many
/// Highlights, Always Show sidenotes under some, hidden runs), then (1) the whole board drawn offscreen in one go
/// (`Picture.draw`: the scene laid out and every card drawn) again and again, timed on this thread's CPU clock, and
/// (2) OpenFrames' open, pan and zoom on it in a window below the desktop picture. No vault folder
enum CodeCards {
  static let cards = 12

  static func make(in root: URL) throws -> [VaultBoard] {
    var cs: [Card] = []
    var notes: [Sidenote] = []
    for k in 0..<cards {
      let seg = SegmentID(rawValue: "s")
      var lines: [String] = []
      for i in 0..<180 {
        switch i % 9 {
        case 0: lines.append("def step_\(k)_\(i)(barrier, n, *, timeout=None):")
        case 1: lines.append("\t\"\"\"等待 \(i) 个线程 and then return the result of the collective call\"\"\"")
        case 2:
          lines.append("\tresult = collective(barrier, n=n, group=group_\(i), tag=\"step-\(i)\", timeout=timeout)")
        case 3: lines.append("")
        case 4: lines.append("\tfor x in range(n):  # 循环 \(i) over every rank in the group, one at a time")
        case 5: lines.append("\t\tif x % 2 == 0 and result[x] is not None and result[x].ready():")
        case 6: lines.append("\t\t\tresult[x] = result[x].wait() + barrier.offset(x, \(i))")
        case 7: lines.append("\t\telse: continue")
        default: lines.append("\treturn result")
        }
      }
      let highlights = stride(from: 2, to: 176, by: 7).map { $0...($0 + 2) }
      let s = Segment(
        id: seg, source: nil, language: "python", firstLine: 1, lines: lines,
        hidden: [40...52, 120...128], highlights: highlights)
      let id = CardID(rawValue: "code\(k)")
      cs.append(
        Card(
          id: id, x: Double(k % 4) * 520, y: Double(k / 4) * 520, width: 480,
          content: .own(CardContent(body: .code(CodeCard(segments: [s], wrap: k % 2 == 0))))))
      for (j, h) in highlights.enumerated() where j % 3 == 0 {
        notes.append(
          Sidenote(
            id: SidenoteID(rawValue: "n\(k)-\(j)"), anchor: .card(id, segment: seg, lines: h),
            body: .text(TextNote(text: "Why **\(j)**: the barrier waits here 等待", alwaysShow: true))))
      }
    }
    let b = Board(id: BoardID(rawValue: "bench-code"), cards: cs, sidenotes: notes)
    let name = "\(b.id.rawValue).board"
    let package = root.appending(path: name)
    try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
    try b.encoded().write(to: package.appending(path: Vault.boardFileName))
    return [VaultBoard(id: b.id, title: "Code", path: name)]
  }

  /// Per scale (0: none rasterized): the median and the lowest of `runs` pictures of the whole board, in ms of this
  /// thread's CPU time; and the highlighter's share of it (it parses every card again for each picture), to take off
  @MainActor static func draw(_ b: VaultBoard, in vault: Vault, runs: Int = 25) throws -> String {
    let board = try vault.board(at: b.path)
    let package = vault.url(of: b.path)
    let highlighter = Highlighter()
    var out: [String] = []
    var parse: [Double] = []
    for _ in 0..<runs {
      let t0 = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
      for c in board.cards {
        guard case .own(let own) = c.content, case .code(let code) = own.body else { continue }
        for s in code.segments { _ = highlighter.tokens(lines: s.lines, language: s.language) }
      }
      parse.append(Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - t0) / 1e6)
    }
    parse.sort()
    out.append(String(format: "\"highlight\":{\"median_ms\":%.1f,\"min_ms\":%.1f}", parse[runs / 2], parse[0]))
    // "draw@0": into a context of one pixel, where nothing is rasterized: the layout, the typesetting and the drawing
    // calls alone
    for scale in [CGFloat(0), 1, 2] {
      let rect =
        scale == 0
        ? CGRect(x: 0, y: 0, width: 1, height: 1) : CGRect(x: -40, y: -40, width: 4 * 520 + 40, height: 3 * 520 + 40)
      var times: [Double] = []
      // the first is a warm-up (fonts, the decode and line caches)
      for r in 0...runs {
        let t0 = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
        let picture = Picture.draw(
          board: board, package: package, vault: vault, theme: .warmInk, highlighter: highlighter, sizes: [:],
          rect: rect, scale: max(scale, 1), backdrop: false)
        let t = Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - t0) / 1e6
        if r > 0 { times.append(t) }
        if r == 0, scale == 2, let img = picture.image { out.append("\"pixels@2\":\"\(fingerprint(img))\"") }
      }
      times.sort()
      out.append(
        String(format: "\"draw@%d\":{\"median_ms\":%.1f,\"min_ms\":%.1f}", Int(scale), times[times.count / 2], times[0])
      )
    }
    return "{\"cards\":\(cards)," + out.joined(separator: ",") + "}"
  }

  /// FNV-1a over the picture's pixels: the same number, the same picture
  static func fingerprint(_ img: CGImage) -> String {
    guard let data = img.dataProvider?.data, let p = CFDataGetBytePtr(data) else { return "none" }
    var h: UInt64 = 0xcbf2_9ce4_8422_2325
    for i in 0..<CFDataGetLength(data) {
      h ^= UInt64(p[i])
      h = h &* 0x100_0000_01b3
    }
    return String(h, radix: 16)
  }
}
