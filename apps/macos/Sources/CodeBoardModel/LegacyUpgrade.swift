import Foundation

// The steps of the extension's packages/core/src/migrate.ts that bring a board file of version 13–16 to version 17, ported
// line for line onto the JSON as JSONSerialization reads it (mutable containers, so a step changes the tree in place as
// the TypeScript does). Strings are handled as JavaScript handles them, in UTF-16 code units, and the regular expressions
// are the TypeScript's with \w and \d spelled out as ASCII, as JavaScript reads them. Tests compare the port with what
// migrate.ts itself makes of the same files (tools/legacy-upgrade/cases.mjs). The ids migrate.ts makes up at random are
// made from the ids they stand next to, so importing the same files twice gives the same vault.

enum LegacyUpgrade {
  /// migrate.ts's BOARD_VERSION
  static let current = 17
  /// The oldest version ported
  static let oldest = 13

  /// migrateBoard for a file of version 13–17: the board as version 17, shared cards still references
  static func board(_ raw: NSMutableDictionary) -> NSMutableDictionary {
    let from = int(raw["version"]) ?? 1
    let b = dropNulls(raw) as! NSMutableDictionary
    for key in ["links", "sections", "sidenotes", "stickers"] where b[key] == nil { b[key] = NSMutableArray() }
    if b["place"] == nil { b["place"] = NSMutableDictionary() }
    b["cam"] = nil
    let cards = list(b["cards"])
    if from < 15 {
      let notes = list(b["sidenotes"]).map { n in
        textOrCodeNote(n, title: { id in boardCardTitle(b, id) })
      }
      b["sidenotes"] = NSMutableArray(array: notes)
    }
    b["version"] = current
    normalize(b)
    if from < 14 {
      for c in objects(cards) where str(c["kind"]) != "shared" { markCard(c) }
      for n in objects(b["sidenotes"]) { markNote(n) }
      for k in objects(b["stickers"]) + shelf(b).flatMap({ objects($0["stickers"]) }) { markQuestion(k) }
    }
    if from < 16 {
      let places = [obj(b["place"])].compactMap { $0 } + shelf(b).compactMap { obj($0["place"]) }
      for c in objects(cards) where str(c["kind"]) != "shared" { textAndBox(c, places: places) }
    }
    if from < 17 { questionStickers(b) }
    return b
  }

  /// migrateSharedCard for a card library file of version 13–17
  static func sharedCard(_ raw: NSMutableDictionary) -> NSMutableDictionary {
    let sc = dropNulls(raw) as! NSMutableDictionary
    let v = int(sc["version"]) ?? 0
    let card = obj(sc["card"])
    if v < 14 {
      if let card { markCard(card) }
      for n in objects(sc["sidenotes"]) { markNote(n) }
    }
    if v < 15 {
      sc["sidenotes"] = NSMutableArray(array: list(sc["sidenotes"]).map { textOrCodeNote($0, title: { _ in nil }) })
    }
    if v < 16, let card { textAndBox(card, places: []) }
    if v < current { sc["version"] = current }
    if let card { normCard(card) }
    for n in objects(sc["sidenotes"]) { normNote(n) }
    return sc
  }

  /// sharedCardRefs, the part of the upgrade that needs the shared cards' content (Storage runs it once it has put them
  /// in): a [[Card#^id]] that the upgrade wrote for a card whose title it could not see gets that card's title.
  /// `version`: the file's own; `shared`: the upgraded content of the library cards, by id
  static func titleRefs(_ b: NSMutableDictionary, version: Int, shared: [String: NSDictionary]) {
    guard version < 17, objects(b["cards"]).contains(where: { str($0["kind"]) == "shared" }) else { return }
    let inflated = objects(b["cards"]).map { c in
      str(c["kind"]) == "shared" ? str(c["id"]).flatMap { shared[$0] } ?? c : c
    }
    let titled = { (md: String) in
      mapRefs(md) { label, target in
        guard label == untitledRef, let target,
          let c = inflated.first(where: { str($0["id"]) == target }), let id = str(c["id"])
        else { return nil }
        return refSource(cardTitle(c, cards: inflated) ?? "", id)
      }
    }
    for n in objects(b["sidenotes"]) where str(n["kind"]) == "text" {
      if version < 15, let md = str(n["md"]) { n["md"] = titled(md) }
      for a in objects(obj(n["q"])?["answers"]) { if let md = str(a["md"]) { a["md"] = titled(md) } }
    }
  }

  // MARK: 16 → 17: question stickers become question sidenotes

  /// How big a canvas sticker is drawn when it stores no size
  private static let stickerSize = 32.0

  private static func questionStickers(_ b: NSMutableDictionary) {
    let cards = objects(b["cards"])
    let sharedIDs = Set(cards.filter { str($0["kind"]) == "shared" }.compactMap { str($0["id"]) })
    let has = { (id: String) in cards.contains { str($0["id"]) == id } }
    var lines = Set<String>()
    let notes = b["sidenotes"] as? NSMutableArray ?? NSMutableArray()
    func turn(_ stickers: [Any], links: [NSMutableDictionary]) -> NSMutableArray {
      NSMutableArray(
        array: stickers.filter { item in
          guard let k = obj(item), oldQuestion(k) else { return true }
          let w = stickerWhere(k, links: links)
          let q = obj(k["q"]) ?? NSMutableDictionary()
          let at = q["at"] ?? NSNumber(value: 0)
          let question = NSMutableDictionary(dictionary: ["at": at])
          let n = NSMutableDictionary(dictionary: [
            "id": k["id"] ?? "", "kind": "text", "md": str(q["md"]) ?? "", "q": question,
          ])
          if truthy(q["done"]) { question["done"] = true }
          if let answer = str(q["answer"]), has(answer) {
            let a = NSMutableDictionary(dictionary: [
              "id": "a-\(str(k["id"]) ?? "")", "md": refSource(boardCardTitle(b, answer) ?? "", answer), "at": at,
            ])
            question["answers"] = NSMutableArray(array: [a])
          }
          let canvas = obj(k["at"])
          if let card = w.card, has(card) {
            if let seg = w.seg, !seg.isEmpty, let line = w.line {
              n["at"] = NSMutableDictionary(dictionary: [
                "card": card, "seg": seg, "lines": NSMutableArray(array: [line, line]),
              ])
            } else {
              n["at"] = NSMutableDictionary(dictionary: ["card": card])
            }
            if sharedIDs.contains(card) {
              n["boardOnly"] = true
            } else if obj(n["at"])?["lines"] != nil {
              lines.insert(card)
            }
          } else if let canvas, str(canvas["kind"]) == "canvas", let x = number(canvas["x"]),
            let y = number(canvas["y"]),
            x.isFinite, y.isFinite
          {
            // a free badge is centred on its point; the sticker was drawn from its top left
            let half = (number(canvas["size"]) ?? stickerSize) / 2
            n["at"] = NSMutableDictionary(dictionary: ["x": jsRound(x + half), "y": jsRound(y + half)])
          } else {
            return false
          }
          notes.add(n)
          return false
        })
    }
    let links = objects(b["links"])
    b["stickers"] = turn(list(b["stickers"]), links: links)
    for e in shelf(b) { e["stickers"] = turn(list(e["stickers"]), links: links + objects(e["links"])) }
    if !lines.isEmpty { fixHighlights(b, cards: lines) }
  }

  private static func oldQuestion(_ k: NSDictionary) -> Bool {
    if truthy(k["q"]) { return true }
    let icon = obj(k["icon"])
    return str(icon?["pack"]) == "builtin" && str(icon?["name"]) == "question"
  }

  /// model.ts stickerWhere: the card (and line) a sticker is on
  static func stickerWhere(_ k: NSDictionary, links: [NSDictionary]) -> (card: String?, seg: String?, line: Any?) {
    guard let at = obj(k["at"]) else { return (nil, nil, nil) }
    if str(at["kind"]) == "line" { return (str(at["card"]), str(at["seg"]), at["line"]) }
    guard let on = obj(at["on"]) else { return (nil, nil, nil) }
    if on["card"] != nil { return (str(on["card"]), nil, nil) }
    guard let l = links.first(where: { str($0["id"]) == str(on["link"]) }), let from = obj(l["from"]) else {
      return (nil, nil, nil)
    }
    return (str(from["card"]), str(from["seg"]), from["line"])
  }

  // MARK: Highlights (edit/highlights.ts fixHighlights, with review false: an old file read)

  private static func fixHighlights(_ b: NSDictionary, cards ids: Set<String>) {
    let notes = objects(b["sidenotes"])
    for c in objects(b["cards"]) where str(c["kind"]) == "code" && ids.contains(str(c["id"]) ?? "") {
      let variants = objects(c["variants"])
      let active = str(c["active"]) ?? "up"
      let on = { (n: NSDictionary, s: NSDictionary) -> Bool in
        let at = obj(n["at"])
        return str(at?["card"]) == str(c["id"]) && str(at?["seg"]) == str(s["id"]) && truthy(at?["lines"])
      }
      for s in objects(c["segments"]) {
        fixSegment(
          s,
          notes.filter { n in
            on(n, s) && (variants.isEmpty || !truthy(n["variant"]) || str(n["variant"]) == active)
          })
      }
      for v in variants {
        for s in objects(v["segs"]) { fixSegment(s, notes.filter { on($0, s) && str($0["variant"]) == str(v["id"]) }) }
      }
    }
  }

  private static func fixSegment(_ s: NSMutableDictionary, _ notes: [NSMutableDictionary]) {
    guard let start = number(s["start"]), let end = number(s["end"]) else { return }
    func clamp(_ r: [Double]) -> [Double] {
      let p = min(max(r[0], start), end)
      return [p, max(p, min(r[1], end))]
    }
    func lines(_ n: NSDictionary) -> [Double]? { pair(obj(n["at"])?["lines"]) }
    func anchor(_ n: NSDictionary, _ r: [Double]) {
      guard let at = obj(n["at"]), let l = lines(n), l != r else { return }
      at["lines"] = NSMutableArray(array: r.map { NSNumber(value: $0) })
    }
    for n in notes { if let l = lines(n) { anchor(n, clamp(l)) } }
    let shared = notes.filter { !truthy($0["boardOnly"]) }
    let before = list(s["hl"]).compactMap(pair)
    let own = before.filter { $0[1] >= start && $0[0] <= end }.map(clamp)
    let rs = unionRanges(own + shared.compactMap(lines))
    if rs != before || list(s["hl"]).count != before.count {
      s["hl"] =
        rs.isEmpty ? nil : NSMutableArray(array: rs.map { NSMutableArray(array: $0.map { NSNumber(value: $0) }) })
    }
    for n in shared {
      guard let l = lines(n), let r = rs.first(where: { l[0] >= $0[0] && l[1] <= $0[1] }), r != l else { continue }
      anchor(n, r)
    }
  }

  /// Sorted, the ranges that overlap or nest merged (adjacent ones stay apart)
  private static func unionRanges(_ rs: [[Double]]) -> [[Double]] {
    var out: [[Double]] = []
    for r in rs.sorted(by: { $0[0] != $1[0] ? $0[0] < $1[0] : $0[1] < $1[1] }) {
      if let last = out.last, r[0] <= last[1] {
        out[out.count - 1][1] = max(last[1], r[1])
      } else {
        out.append(r)
      }
    }
    return out
  }

  // MARK: normalize (every version)

  private static func normalize(_ b: NSMutableDictionary) {
    let place = obj(b["place"])
    for c in objects(b["cards"]) where str(c["kind"]) != "shared" { normCard(c) }
    for c in objects(b["cards"]) where str(c["kind"]) == "image" {
      if let id = str(c["id"]), let p = obj(place?[id]) { p["h"] = nil }
    }
    for s in objects(b["sections"]) where s["title"] == nil { s["title"] = "" }
    for c in objects(b["cards"]) where str(c["kind"]) == "board" && number(c["pcols"]) != 2 { c["pcols"] = nil }
    for l in objects(b["links"]) { normLink(l) }
    for n in objects(b["sidenotes"]) { normNote(n) }
    cornerStickers(b)
    for k in objects(b["stickers"]) { if let q = obj(k["q"]) { dropFalse(q, ["done"]) } }
  }

  private static func normSeg(_ s: NSMutableDictionary) {
    if s["lang"] == nil { s["lang"] = "plaintext" }
  }

  private static func normCard(_ c: NSMutableDictionary) {
    dropFalse(c, ["tilt"])
    if str(c["kind"]) == "image" { dropFalse(c, ["loop"]) }
    guard str(c["kind"]) == "code" else { return }
    dropFalse(c, ["keepOld"])
    if isTrue(c["bg"]) { c["bg"] = nil }
    for s in objects(c["segments"]) { normSeg(s) }
    for v in objects(c["variants"]) { for s in objects(v["segs"]) { normSeg(s) } }
    for m in objects(c["mergedFrom"]) { if let card = obj(m["card"]) { normCard(card) } }
  }

  private static func normNote(_ n: NSMutableDictionary) {
    dropFalse(n, ["boardOnly"])
    if str(n["kind"]) == "code", let code = obj(n["code"]) { normSeg(code) }
  }

  private static func normLink(_ l: NSMutableDictionary) {
    dropFalse(l, ["gen", "back"])
    if truthy(l["gen"]) && (truthy(l["call"]) || truthy(l["rpc"]) || truthy(l["back"])) { l["gen"] = nil }
    if let style = obj(l["style"]) { dropFalse(style, ["dash"]) }
    if let lost = obj(l["lost"]) { dropFalse(lost, ["from", "to"]) }
    obj(l["from"])?["sub"] = nil
    if let to = obj(l["to"]), to["sub"] != nil {
      to["sub"] = nil
      if let lost = obj(l["lost"]) {
        lost["to"] = nil
        if !truthy(lost["from"]) { l["lost"] = nil }
      }
    }
  }

  /// The old stickers in a row on a card's top right corner, as stickers bound to the card where that row was
  private static func cornerStickers(_ b: NSDictionary) {
    var host: [String: String] = [:]
    for c in objects(b["cards"]) where str(c["kind"]) == "compare" {
      for k in list(c["cols"]).compactMap(str) { host[k] = str(c["id"]) }
    }
    var row: [String: Int] = [:]
    let place = obj(b["place"])
    for k in objects(b["stickers"]) {
      guard let at = obj(k["at"]), str(at["kind"]) == "card", let on = str(at["card"]) else { continue }
      let card = host[on] ?? on
      let i = row[card] ?? 0
      row[card] = i + 1
      let w = number(obj(place?[card])?["w"]) ?? 320
      k["at"] = NSMutableDictionary(dictionary: [
        "kind": "canvas", "x": w - 56 - Double(i) * 25, "y": -11, "size": 22,
        "on": NSMutableDictionary(dictionary: ["card": card]),
      ])
    }
  }

  private static func dropFalse(_ o: NSMutableDictionary, _ keys: [String]) {
    for k in keys where isFalse(o[k]) { o[k] = nil }
  }

  // MARK: 14 → 15: sidenotes are Text or Code

  /// A link's title as Markdown text: the characters that would start a mark, a formula or a link written literally
  private static func mdText(_ s: String) -> String { re(#"[\\`*_\[\]<>$~=^]"#).replace(s) { "\\" + $0[0] } }

  private static func textOrCodeNote(_ item: Any, title: (String) -> String?) -> Any {
    guard let n = obj(item) else { return item }
    switch str(n["kind"]) {
    case "link":
      let rest = without(n, ["kind", "url", "title"])
      let u = str(n["url"]) ?? ""
      let dest = re(#"[\s()]"#).test(u) ? "<\(u)>" : u
      let t = truthy(n["title"]) ? str(n["title"]) ?? u : u
      rest["kind"] = "text"
      rest["md"] = "[\(mdText(t))](\(dest))"
      return rest
    case "paste":
      let rest = without(n, ["kind", "text", "lang", "url"])
      let text = str(n["text"]) ?? ""
      let lines = text.components(separatedBy: "\n")
      let src = NSMutableDictionary(dictionary: ["kind": "free"])
      if truthy(n["url"]) { src["url"] = n["url"] }
      let lang = str(n["lang"]).flatMap { $0.isEmpty ? nil : $0 } ?? "plaintext"
      rest["kind"] = "code"
      rest["code"] = NSMutableDictionary(dictionary: [
        "id": "s-\(str(n["id"]) ?? "")", "src": src, "path": "", "lang": lang, "start": 1, "end": lines.count,
        "text": NSMutableArray(array: lines), "version": NSMutableDictionary(dictionary: ["kind": "none"]),
      ])
      return rest
    case "card":
      let rest = without(n, ["kind", "card"])
      rest["kind"] = "text"
      let card = str(n["card"]) ?? ""
      rest["md"] = refSource(title(card) ?? "", card)
      rest["boardOnly"] = true
      return rest
    default:
      return n
    }
  }

  private static func without(_ o: NSDictionary, _ keys: Set<String>) -> NSMutableDictionary {
    let out = NSMutableDictionary()
    for (k, v) in o where !keys.contains(k as? String ?? "") { out[k] = v }
    return out
  }

  // MARK: Card titles (model.ts cardTitle)

  private static func boardCardTitle(_ b: NSDictionary, _ id: String) -> String? {
    let cards = objects(b["cards"])
    guard let c = cards.first(where: { str($0["id"]) == id }), str(c["kind"]) != "shared" else { return nil }
    return cardTitle(c, cards: cards)
  }

  static func cardTitle(_ c: NSDictionary, cards: [NSDictionary]) -> String? {
    if truthy(c["title"]) { return str(c["title"]) }
    switch str(c["kind"]) {
    case "code": return codeTitle(c)
    case "note":
      let l = firstLine(str(c["md"]) ?? "")
      if !l.isEmpty { return l }
      return ["note": "Note", "text": "Text", "box": "Box"][str(c["look"]) ?? ""]
    case "image": return truthy(c["alt"]) ? str(c["alt"]) : "Image"
    case "web":
      if let t = str(obj(c["meta"])?["title"]), !t.isEmpty { return t }
      let url = str(c["url"]) ?? ""
      guard let host = URLComponents(string: url)?.host, !host.isEmpty else { return url }
      return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    case "links": return "Link List"
    case "compare":
      let ids = list(c["cols"]).compactMap(str)
      let cols = ids.compactMap { id in cards.first { str($0["id"]) == id && str($0["kind"]) == "code" } }
      guard ids.count == 2, cols.count == 2 else { return "Compare · " }
      let short = { (s: String) in s.split(separator: ".", omittingEmptySubsequences: false).last.map(String.init) ?? s
      }
      let names = cols.map { short(cardTitle($0, cards: cards) ?? "") }
      if names[0] == names[1] {
        let labels = cols.map { versionLabel(obj(objects($0["segments"]).first?["version"])) }
        return "Compare · \(names[0]) · \(labels[0]) ↔ \(labels[1])"
      }
      return "Compare · \(names[0]) ↔ \(names[1])"
    case "board": return "Board"
    default: return nil
    }
  }

  private static func codeTitle(_ c: NSDictionary) -> String {
    guard let s = objects(c["segments"]).first else { return "Empty" }
    if str(obj(s["src"])?["kind"]) == "free" { return "Code" }
    let path = str(s["path"]) ?? ""
    let base = path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
    let lines = "\(jsNumber(s["start"]))–\(jsNumber(s["end"]))"
    if let symbol = obj(s["symbol"]) {
      return str(symbol["kind"]) == "module" ? "\(base) (top)" : str(symbol["qual"]) ?? ""
    }
    if truthy(s["scope"]) { return "\(str(s["scope"]) ?? "") \(lines)" }
    return "\(base) \(lines)"
  }

  private static func versionLabel(_ v: NSDictionary?) -> String {
    guard let v else { return "" }
    switch str(v["kind"]) {
    case "git": return String((str(v["commit"]) ?? "").prefix(7))
    case "pkg": return "\(str(v["name"]) ?? "") \(str(v["version"]) ?? "")"
    case "hash": return "Unknown version · \(String((str(v["hash"]) ?? "").utf16.prefix(4)) ?? "")"
    case "none": return "No commit"
    default: return ""
    }
  }

  /// The first line of Markdown that has text, as a title
  static func firstLine(_ md: String) -> String {
    for l in md.components(separatedBy: "\n") {
      var t = re(#"!\[([^\]\n]*)\]\([^)\n]*\)"#).replace(l) { $0[1] }
      t = re(#"^[#>\-*\s]+"#).replace(t, once: true) { _ in "" }
      t = re(#"\*\*|`"#).replace(t) { _ in "" }
      t = re(#"\\([!-/:-@\[-`{-~])"#).replace(t) { $0[1] }
      t = t.replacingOccurrences(of: "&nbsp;", with: " ").replacingOccurrences(of: "&amp;", with: "&")
      t = jsTrim(t)
      if !t.isEmpty { return t }
    }
    return ""
  }

  // MARK: [[refs]] (mdrefs.ts)

  static let untitledRef = "Card"

  /// A reference to `id` with `label` as its text (mdrefs.ts refSource)
  static func refSource(_ label: String, _ id: String) -> String {
    let l = jsTrim(re(#"[\[\]\n]"#).replace(label) { _ in " " })
    return "[[\(l.isEmpty ? untitledRef : l)#^\(id)]]"
  }

  /// Each [[ref]] outside code replaced by what `f` gives (nil: left as written)
  static func mapRefs(_ md: String, _ f: (String, String?) -> String?) -> String {
    guard md.contains("[[") else { return md }
    var out: [String] = []
    var fence = ""
    var run: [String] = []
    func flush() {
      if !run.isEmpty { out.append(inlineRefs(run.joined(separator: "\n"), f)) }
      run = []
    }
    for l in md.components(separatedBy: "\n") {
      if !fence.isEmpty {
        out.append(l)
        if fenceCloses(l, fence) { fence = "" }
      } else if let m = re("^ {0,3}(`{3,}|~{3,})").exec(l) {
        flush()
        fence = m[1]
        out.append(l)
      } else {
        run.append(l)
      }
    }
    flush()
    return out.joined(separator: "\n")
  }

  private static func inlineRefs(_ text: String, _ f: (String, String?) -> String?) -> String {
    let src = text as NSString
    var out = ""
    var i = 0
    let ref = re(#"\[\[([^\[\]\n]+?)\]\]"#)
    while i < src.length {
      let rest = NSRange(location: i, length: src.length - i)
      let tick = src.range(of: "`", options: .literal, range: rest).location
      let at = src.range(of: "[[", options: .literal, range: rest).location
      if at == NSNotFound { break }
      if tick != NSNotFound && tick < at {
        let end = codeSpanEnd(src, tick)
        out += src.substring(with: NSRange(location: i, length: end - i))
        i = end
        continue
      }
      guard let m = ref.exec(src, from: at), m.at == at else {
        out += src.substring(with: NSRange(location: i, length: at + 2 - i))
        i = at + 2
        continue
      }
      let inner = m[1]
      var label = jsTrim(inner)
      var target: String?
      if let t = re(#"#\^([A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)?)$"#).exec(inner) {
        label = jsTrim((inner as NSString).substring(to: t.at))
        target = t[1]
      }
      let to = label.isEmpty ? nil : f(label, target)
      out += src.substring(with: NSRange(location: i, length: at - i)) + (to ?? m[0])
      i = at + m.length
    }
    return out + src.substring(from: i)
  }

  /// `md` with `f` applied to its prose: fenced code blocks and inline code spans stay as written
  static func mapProse(_ md: String, _ f: (String) -> String) -> String {
    var out: [String] = []
    var fence = ""
    var run: [String] = []
    func flush() {
      if !run.isEmpty { out.append(proseSpans(run.joined(separator: "\n"), f)) }
      run = []
    }
    for l in md.components(separatedBy: "\n") {
      if !fence.isEmpty {
        out.append(l)
        if fenceCloses(l, fence) { fence = "" }
      } else if let m = re("^ {0,3}(`{3,}|~{3,})").exec(l) {
        flush()
        fence = m[1]
        out.append(l)
      } else {
        run.append(l)
      }
    }
    flush()
    return out.joined(separator: "\n")
  }

  private static func proseSpans(_ text: String, _ f: (String) -> String) -> String {
    let src = text as NSString
    var out = ""
    var i = 0
    while i < src.length {
      let tick = src.range(of: "`", options: .literal, range: NSRange(location: i, length: src.length - i)).location
      if tick == NSNotFound { break }
      let end = codeSpanEnd(src, tick)
      out += f(src.substring(with: NSRange(location: i, length: tick - i)))
      out += src.substring(with: NSRange(location: tick, length: end - tick))
      i = end
    }
    return out + f(src.substring(from: i))
  }

  /// Where an inline code span opened at `tick` ends (after its closing run), or just after its opening run if none
  private static func codeSpanEnd(_ src: NSString, _ tick: Int) -> Int {
    let n = re("^`+").exec(src.substring(from: tick))![0].utf16.count
    let rest = src.substring(from: tick + n)
    guard let close = re("(?<!`)`{\(n)}(?!`)").exec(rest) else { return tick + n }
    return tick + n + close.at + n
  }

  private static func fenceCloses(_ line: String, _ fence: String) -> Bool {
    re("^ {0,3}\(NSRegularExpression.escapedPattern(for: String(fence.prefix(1)))){\(fence.utf16.count),}\\s*$")
      .test(line)
  }

  // MARK: 13 → 14: <mark>…</mark> → ==…==

  private static func markCard(_ c: NSMutableDictionary) {
    if let d = str(c["desc"]) { c["desc"] = markTags(d) }
    // a Free Text's md is plain text, not Markdown
    if str(c["kind"]) == "note", str(c["look"]) != "freetext", let md = str(c["md"]) { c["md"] = markTags(md) }
    for m in objects(c["mergedFrom"]) { if let card = obj(m["card"]) { markCard(card) } }
  }

  private static func markNote(_ n: NSMutableDictionary) {
    if str(n["kind"]) == "text", let md = str(n["md"]) { n["md"] = markTags(md) }
  }

  private static func markQuestion(_ k: NSMutableDictionary) {
    if let q = obj(k["q"]), let md = str(q["md"]) { q["md"] = markTags(md) }
  }

  /// A line's list and quote markers and its indent
  private static let container = re(#"^(?:\s*(?:>|[-+*](?=\s)|[0-9]{1,9}[.)](?=\s)))*\s*"#)

  static func markTags(_ md: String) -> String {
    guard re("<mark>", "i").test(md) else { return md }
    var out: [String] = []
    var run: [String] = []
    var fence = ""
    var cont = ""
    var html = false
    func flush() {
      if !run.isEmpty { out.append(markText(run.joined(separator: "\n"))) }
      run = []
    }
    func fixed(_ l: String) {
      flush()
      out.append(l)
    }
    for l in md.components(separatedBy: "\n") {
      let line = l as NSString
      // inside a fence only its own container's prefix comes off a line; a line without it ends the container
      if !fence.isEmpty && (l.hasPrefixUTF16(cont) || jsTrim(l).isEmpty) {
        fixed(l)
        if fenceCloses(line.substring(from: min(cont.utf16.count, line.length)), fence) { fence = "" }
        continue
      }
      fence = ""
      let inner = container.replace(l, once: true) { _ in "" }
      if let f = re("^(`{3,}|~{3,})").exec(inner) {
        fence = f[1]
        cont = contOf(line.substring(to: line.length - inner.utf16.count))
        fixed(l)
      } else if html {
        fixed(l)
        html = !jsTrim(l).isEmpty
      } else if re("^ {0,3}<[A-Za-z/!?]").test(l) && !re("^ {0,3}<mark>", "i").test(l) {
        html = true
        fixed(l)
      } else if re("^( {4}|\t)").test(l) && !(run.last.map { !jsTrim($0).isEmpty } ?? false) {
        fixed(l)
      } else {
        run.append(l)
      }
    }
    flush()
    return out.joined(separator: "\n")
  }

  /// What the lines inside a fence opened after this prefix start with: its quote markers
  private static func contOf(_ prefix: String) -> String {
    jsTrimEnd(re(#"[-+*]|[0-9]{1,9}[.)]"#).replace(prefix) { String(repeating: " ", count: $0[0].utf16.count) })
  }

  /// Lines of text (no code or HTML blocks): inline code spans and formulas skipped
  private static func markText(_ text: String) -> String {
    let src = text as NSString
    var out = ""
    var i = 0
    // where the last rewritten <mark> ended: one right after it stays as written (==a====b== would read as one run)
    var last = -1
    let tag = re(#"(?<!\\)(\\*)<mark>([^<>\n]*)</mark>"#, "i")
    func char(_ at: Int) -> String {
      at >= 0 && at < src.length ? src.substring(with: NSRange(location: at, length: 1)) : ""
    }
    func marks(_ from: Int, _ to: Int) -> String {
      tag.replace(src.substring(with: NSRange(location: from, length: to - from))) { m in
        let esc = m[1]
        let x = m[2]
        let t = jsTrim(x)
        let abs = from + m.at
        let before = char(abs - 1 + esc.utf16.count)
        let after = char(abs + m.length)
        if esc.utf16.count % 2 == 1 || t.isEmpty || t.contains("==") || re(#"^=|[=\\]$"#).test(t) || before == "="
          || after == "=" || abs == last
        {
          return m[0]
        }
        last = abs + m.length
        let lead = (x as NSString).substring(to: x.utf16.count - jsTrimStart(x).utf16.count)
        let trail = (x as NSString).substring(from: jsTrimEnd(x).utf16.count)
        return "\(esc)\(lead)==\(t)==\(trail)"
      }
    }
    while i < src.length {
      guard let at = skipAt(src, i) else {
        out += marks(i, src.length)
        break
      }
      out += marks(i, at.0) + src.substring(with: NSRange(location: at.0, length: at.1 - at.0))
      i = at.1
    }
    return out
  }

  /// The next inline code span or formula from i on, as (start, end): nil when there is no ` or unescaped $ left
  private static func skipAt(_ src: NSString, _ from: Int) -> (Int, Int)? {
    let open = re(#"`+|(?<!\\)\$\$?"#)
    var i = from
    while let m = open.exec(src, from: i) {
      let s = m.at
      let d = m[0]
      let n = d.utf16.count
      if d.hasPrefix("`") { return (s, codeSpanEnd(src, s)) }
      // a formula ends at the same $ or $$ before a blank line; an unclosed $ is a dollar sign
      let rest = src.substring(from: s + n)
      let para = re(#"\n\s*\n"#).exec(rest)?.at
      let within = para.map { (rest as NSString).substring(to: $0) } ?? rest
      if let close = re(d == "$$" ? #"(?<!\\)\$\$"# : #"(?<!\\)\$(?!\$)"#).exec(within) {
        return (s, s + n + close.at + n)
      }
      i = s + n
    }
    return nil
  }

  // MARK: → 16: Text, Mark, Free Text and Box become a Text or a Box

  /// Warm Ink's sizes of the old Text's three levels (px)
  private static let oldTextPX = ["title": 26.0, "heading": 16.0, "body": 13.5]
  /// An old Free Text's size at each level (0 = plain, 1–3 = H1–H3) when it stored none (px)
  private static let oldFreePX = [20.0, 40, 30, 24]
  private static let oldMarkPX = 18.0
  private static let oldBoxPX = 13.5
  /// How much larger than a Text's own size its # and ## headings are
  private static let headingScale = [1, 1.8, 1.35]
  /// A line Markdown reads as the start of a block (heading, quote, list, rule, fence, table, math, image)
  private static let blockStart = re(#"^\s*(?:#|>|[-+*]\s|[0-9]+[.)]|```|~~~|\||\$\$|!\[)"#)

  private static func textAndBox(_ c: NSMutableDictionary, places: [NSMutableDictionary]) {
    guard str(c["kind"]) == "note" else { return }
    var fs: Double?
    switch str(c["look"]) {
    case "text":
      fs = oldTextLevel(c)
      c["wrap"] = true
    case "freetext":
      let level = Int(number(c["level"]) ?? 0)
      let heading = level == 3 ? 2 : level != 0 ? 1 : 0
      c["md"] = plainToMarkdown(str(c["md"]) ?? "", heading: heading, bold: truthy(c["bold"]))
      if let size = number(c["fs"]) ?? (oldFreePX.indices.contains(level) ? oldFreePX[level] : nil) {
        fs = size / headingScale[heading]
      }
      c["look"] = "text"
      c["mdLayout"] = nil
    case "mark":
      fs = number(c["fs"]) ?? oldMarkPX
      c["look"] = "text"
      c["wrap"] = true
    case "box":
      fs = oldBoxPX
      c["wrap"] = true
      if let id = str(c["id"]) { for p in places { obj(p[id])?["h"] = nil } }
    default: break
    }
    for k in ["size", "bold", "hand", "weight", "level", "fs"] { c[k] = nil }
    guard let fs else { return }
    let size = min(TextCard.fontSizes.upperBound, max(TextCard.fontSizes.lowerBound, jsRound(fs * 2) / 2))
    if size != TextCard.sizes[0] { c["fs"] = size }
  }

  /// The old Text's Markdown at a title or heading level, and the text size it takes
  private static func oldTextLevel(_ c: NSMutableDictionary) -> Double {
    let size = str(c["size"]) ?? ""
    let px = oldTextPX[size] ?? oldTextPX["body"]!
    let heading = size == "title" ? 1 : size == "heading" ? 2 : 0
    let md = str(c["md"]) ?? ""
    let trimmed = jsTrim(md)
    let paras = trimmed.isEmpty ? [] : re(#"\n\s*\n"#).split(trimmed)
    let plain = !paras.isEmpty && paras.allSatisfy { !$0.contains("\n") && !blockStart.test($0) }
    if heading != 0 && plain {
      c["md"] = paras.map { "\(String(repeating: "#", count: heading)) \(jsTrim($0))" }.joined(separator: "\n\n")
      return px / headingScale[heading]
    }
    // bold around text with its own * marks would nest them into something else
    if truthy(c["bold"]) && plain && !md.contains("*") {
      c["md"] = paras.map { "**\(jsTrim($0))**" }.joined(separator: "\n\n")
    }
    return px
  }

  /// An old Free Text's plain text as Markdown that shows the same
  private static func plainToMarkdown(_ text: String, heading: Int, bold: Bool) -> String {
    guard !jsTrim(text).isEmpty else { return "" }
    return re(#"\s+$"#).replace(text, once: true) { _ in "" }.components(separatedBy: "\n").map { line in
      let body = jsTrimEnd(line)
      if jsTrim(body).isEmpty { return "&nbsp;" }
      let start = jsTrimStart(body)
      let lead = body.utf16.count - start.utf16.count
      var md = re(" {2,}").replace(escapePlain(start)) { m in
        " " + String(repeating: "\u{a0}", count: m[0].utf16.count - 1)
      }
      if bold { md = "**\(md)**" }
      md = String(repeating: "\u{a0}", count: lead) + md
      return heading != 0 ? "\(String(repeating: "#", count: heading)) \(md)" : md
    }.joined(separator: "\n\n")
  }

  /// Plain text escaped where Markdown (with the board's own marks) reads markup
  private static func escapePlain(_ s: String) -> String {
    var out = re(#"[\\`*_~$\[\]<^{|]"#).replace(s) { "\\" + $0[0] }
    out = out.replacingOccurrences(of: "==", with: "\\==")
    out = re(#"&(?=#?[A-Za-z0-9_]+;)"#).replace(out) { _ in "&amp;" }
    out = re(#":(?=[A-Za-z0-9_+-]+:)"#).replace(out) { _ in "\\:" }
    out = re("^#").replace(out, once: true) { _ in "\\#" }
    out = re("^[-+>]").replace(out, once: true) { "\\" + $0[0] }
    return re(#"^([0-9]+)([.)])"#).replace(out, once: true) { "\($0[1])\\\($0[2])" }
  }

  // MARK: JSON values as JavaScript sees them

  private static func dropNulls(_ x: Any) -> Any {
    if let a = x as? NSArray { return NSMutableArray(array: a.map(dropNulls)) }
    guard let o = x as? NSDictionary else { return x }
    let out = NSMutableDictionary()
    for (k, v) in o where !(v is NSNull) { out[k] = dropNulls(v) }
    return out
  }

  static func obj(_ v: Any?) -> NSMutableDictionary? { v as? NSMutableDictionary }
  static func list(_ v: Any?) -> [Any] { (v as? NSArray).map { Array($0) } ?? [] }
  static func objects(_ v: Any?) -> [NSMutableDictionary] { list(v).compactMap(obj) }
  private static func shelf(_ b: NSDictionary) -> [NSMutableDictionary] { objects(b["shelf"]) }
  static func str(_ v: Any?) -> String? { v as? String }

  static func isBool(_ v: Any?) -> Bool {
    guard let n = v as? NSNumber else { return false }
    return CFGetTypeID(n) == CFBooleanGetTypeID()
  }
  private static func isTrue(_ v: Any?) -> Bool { isBool(v) && (v as! NSNumber).boolValue }
  private static func isFalse(_ v: Any?) -> Bool { isBool(v) && !(v as! NSNumber).boolValue }

  /// A number that is not a boolean
  static func number(_ v: Any?) -> Double? {
    guard let n = v as? NSNumber, !isBool(n) else { return nil }
    return n.doubleValue
  }
  private static func int(_ v: Any?) -> Int? { number(v).flatMap { Int(exactly: $0) } }
  private static func pair(_ v: Any?) -> [Double]? {
    let a = list(v).compactMap(number)
    return a.count == 2 && list(v).count == 2 ? a : nil
  }

  /// JavaScript's !!v
  static func truthy(_ v: Any?) -> Bool {
    switch v {
    case nil, is NSNull: false
    case let n as NSNumber: isBool(n) ? n.boolValue : n.doubleValue != 0 && !n.doubleValue.isNaN
    case let s as String: !s.isEmpty
    default: true
    }
  }

  /// Math.round
  private static func jsRound(_ x: Double) -> Double { (x + 0.5).rounded(.down) }

  /// A number as JavaScript writes it in a string
  private static func jsNumber(_ v: Any?) -> String {
    guard let n = number(v) else { return "undefined" }
    if let i = Int(exactly: n) { return String(i) }
    return String(n)
  }
}

// MARK: Strings and regular expressions as JavaScript handles them (UTF-16 code units)

/// JavaScript's white space and line terminators, which trim() removes
private func jsSpace(_ u: UInt16) -> Bool {
  switch u {
  case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
  default: false
  }
}

func jsTrim(_ s: String) -> String { jsTrimEnd(jsTrimStart(s)) }

func jsTrimStart(_ s: String) -> String {
  let u = Array(s.utf16)
  let i = u.firstIndex { !jsSpace($0) } ?? u.count
  return String(decoding: u[i...], as: UTF16.self)
}

func jsTrimEnd(_ s: String) -> String {
  let u = Array(s.utf16)
  let i = u.lastIndex { !jsSpace($0) }.map { $0 + 1 } ?? 0
  return String(decoding: u[..<i], as: UTF16.self)
}

extension String {
  fileprivate func hasPrefixUTF16(_ p: String) -> Bool { utf16.starts(with: p.utf16) }
}

/// A regular expression used as JavaScript uses one; flags "i" (ignore case) and "m" (^ and $ at every line)
func re(_ pattern: String, _ flags: String = "") -> JSRegex { JSRegex(pattern, flags) }

struct JSRegex {
  struct Match {
    let groups: [String]
    /// Where it starts and how long it is, in UTF-16 code units
    let at: Int
    let length: Int
    subscript(_ i: Int) -> String { i < groups.count ? groups[i] : "" }
  }

  private let regex: NSRegularExpression

  init(_ pattern: String, _ flags: String) {
    var options: NSRegularExpression.Options = [.useUnixLineSeparators]
    if flags.contains("i") { options.insert(.caseInsensitive) }
    if flags.contains("m") { options.insert(.anchorsMatchLines) }
    regex = try! NSRegularExpression(pattern: pattern, options: options)
  }

  private func match(_ r: NSTextCheckingResult, in s: NSString) -> Match {
    Match(
      groups: (0..<r.numberOfRanges).map { i in
        let g = r.range(at: i)
        return g.location == NSNotFound ? "" : s.substring(with: g)
      }, at: r.range.location, length: r.range.length)
  }

  func test(_ s: String) -> Bool { exec(s) != nil }

  func exec(_ s: String) -> Match? { exec(s as NSString, from: 0) }

  /// The first match at or after `from` (as JavaScript's lastIndex: what is before it can still be looked behind at)
  func exec(_ s: NSString, from: Int) -> Match? {
    guard from <= s.length else { return nil }
    let r = regex.firstMatch(
      in: s as String, options: [.withTransparentBounds, .withoutAnchoringBounds],
      range: NSRange(location: from, length: s.length - from))
    return r.map { match($0, in: s) }
  }

  /// replace() with a global expression (once: a non-global one), each match by what `f` gives
  func replace(_ s: String, once: Bool = false, _ f: (Match) -> String) -> String {
    let ns = s as NSString
    var out = ""
    var i = 0
    var results = regex.matches(in: s, range: NSRange(location: 0, length: ns.length))
    if once { results = Array(results.prefix(1)) }
    for r in results {
      out += ns.substring(with: NSRange(location: i, length: r.range.location - i)) + f(match(r, in: ns))
      i = r.range.location + r.range.length
    }
    return out + ns.substring(from: i)
  }

  /// split() by this expression (it has no groups)
  func split(_ s: String) -> [String] {
    let ns = s as NSString
    var out: [String] = []
    var i = 0
    for r in regex.matches(in: s, range: NSRange(location: 0, length: ns.length)) where r.range.length > 0 {
      out.append(ns.substring(with: NSRange(location: i, length: r.range.location - i)))
      i = r.range.location + r.range.length
    }
    return out + [ns.substring(from: i)]
  }
}
