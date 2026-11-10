import AppKit
import CoreText

/// One card as the canvas draws it: a rectangle in board coordinates and the text laid out once.
final class Card {
    enum Kind { case code, note, frameless, image, board }
    let id: String
    let kind: Kind
    let title: String
    let body: String
    var rect: CGRect  // board coordinates, y down
    var image: CGImage?
    /// Body text laid out at the card's width in board units; immutable, shared by every thread that draws the card.
    var frame: CTFrame?

    init(id: String, kind: Kind, title: String, body: String, rect: CGRect) {
        self.id = id; self.kind = kind; self.title = title; self.body = body; self.rect = rect
    }
}

struct Section { let title: String; let rect: CGRect }
struct Link { let from: String; let to: String }

final class Board {
    let name: String
    let path: String
    var cards: [Card] = []
    var sections: [Section] = []
    var links: [Link] = []
    var bounds = CGRect.zero

    static let header: CGFloat = 26
    static let pad: CGFloat = 10
    static let maxAutoHeight: CGFloat = 1200

    init(path: String, vault: String) throws {
        self.path = path
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        guard let d = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NSError(domain: "board", code: 1) }
        name = (d["name"] as? String) ?? (path as NSString).lastPathComponent
        let place = d["place"] as? [String: [String: Any]] ?? [:]
        for raw in d["cards"] as? [[String: Any]] ?? [] {
            guard let id = raw["id"] as? String, let p = place[id] else { continue }
            var c = raw
            if (raw["kind"] as? String) == "shared",
               let sd = try? Data(contentsOf: URL(fileURLWithPath: "\(vault)/cards/\(id).json")),
               let s = try? JSONSerialization.jsonObject(with: sd) as? [String: Any], let sc = s["card"] as? [String: Any] {
                c = sc
            }
            let x = num(p["x"]), y = num(p["y"]), w = max(num(p["w"]), 40)
            let h = p["h"].map(num), mh = p["mh"].map(num)
            let card: Card
            switch c["kind"] as? String {
            case "code":
                let segs = c["segments"] as? [[String: Any]] ?? []
                let text = segs.map { ($0["text"] as? [String] ?? []).joined(separator: "\n") }.joined(separator: "\n\n")
                let path = segs.first?["path"] as? String ?? ""
                let title = (c["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (path as NSString).lastPathComponent
                card = Card(id: id, kind: .code, title: title, body: text, rect: CGRect(x: x, y: y, width: w, height: 0))
                if let h { card.rect.size.height = h + Board.header + 8 } else if let mh { card.rect.size.height = mh }
            case "note", "text":
                let look = c["look"] as? String ?? "note"
                card = Card(id: id, kind: look == "note" ? .note : .frameless, title: "", body: c["md"] as? String ?? "",
                            rect: CGRect(x: x, y: y, width: w, height: h ?? mh ?? 0))
            case "image":
                card = Card(id: id, kind: .image, title: "", body: "", rect: CGRect(x: x, y: y, width: w, height: h ?? mh ?? 0))
                if let src = c["src"] as? String, let img = NSImage(contentsOfFile: "\(vault)/assets/\(src)") {
                    card.image = img.cgImage(forProposedRect: nil, context: nil, hints: nil)
                    if card.rect.height == 0, img.size.width > 0 { card.rect.size.height = w * img.size.height / img.size.width }
                }
            case "board":
                card = Card(id: id, kind: .board, title: "Board", body: c["board"] as? String ?? "",
                            rect: CGRect(x: x, y: y, width: w, height: h ?? mh ?? 200))
            default:
                card = Card(id: id, kind: .note, title: "", body: "(\(c["kind"] as? String ?? "?"))",
                            rect: CGRect(x: x, y: y, width: w, height: h ?? mh ?? 80))
            }
            Render.layout(card)
            cards.append(card)
        }
        for s in d["sections"] as? [[String: Any]] ?? [] {
            sections.append(Section(title: s["title"] as? String ?? "",
                                    rect: CGRect(x: num(s["x"]), y: num(s["y"]), width: num(s["w"]), height: num(s["h"]))))
        }
        for l in d["links"] as? [[String: Any]] ?? [] {
            if let f = (l["from"] as? [String: Any])?["card"] as? String, let t = (l["to"] as? [String: Any])?["card"] as? String {
                links.append(Link(from: f, to: t))
            }
        }
        bounds = cards.reduce(sections.reduce(CGRect.null) { $0.union($1.rect) }) { $0.union($1.rect) }
        if bounds.isNull { bounds = CGRect(x: 0, y: 0, width: 1000, height: 800) }
    }

    /// The boards of a vault, largest file first.
    static func list(vault: String) -> [String] {
        let fm = FileManager.default
        let files = (try? fm.contentsOfDirectory(atPath: vault)) ?? []
        return files.filter { $0.hasSuffix(".json") }.map { "\(vault)/\($0)" }.sorted {
            let a = (try? fm.attributesOfItem(atPath: $0)[.size] as? Int) ?? 0
            let b = (try? fm.attributesOfItem(atPath: $1)[.size] as? Int) ?? 0
            return a > b
        }
    }
}

private func num(_ v: Any?) -> CGFloat {
    if let n = v as? NSNumber { return CGFloat(n.doubleValue) }
    return 0
}
