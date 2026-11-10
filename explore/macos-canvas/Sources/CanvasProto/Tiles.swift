import AppKit
import QuartzCore

/// Mode 4: like "ahead", but a card is cut into 512 px tiles at a power-of-two scale ("level", device pixels per board
/// unit) and only tiles in the viewport plus a margin are drawn and kept. The card's fit-zoom bitmap stays underneath as
/// the fallback, so newly exposed area is never empty. Tiles of the previous level stay until the new level covers the
/// card's visible part, then go.
final class Tile {
    let level: Int           // exponent: scale = 2^level
    let x: Int, y: Int       // index in card-local tile grid (y up)
    let layer = CALayer()
    var ready = false
    var op: Operation?
    var bytes = 0
    init(level: Int, x: Int, y: Int) {
        self.level = level; self.x = x; self.y = y
        layer.anchorPoint = .zero
        layer.contentsGravity = .resize
        layer.minificationFilter = .trilinear
        layer.actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull(), "hidden": NSNull()]
    }
}

final class CardTiles {
    var level: Int?                       // current level exponent
    var tiles: [String: Tile] = [:]       // "level/x/y"
    static func key(_ l: Int, _ x: Int, _ y: Int) -> String { "\(l)/\(x)/\(y)" }
}

enum TileGeo {
    static let px: CGFloat = 512
    static func scale(_ l: Int) -> CGFloat { pow(2, CGFloat(l)) }
    static func size(_ l: Int) -> CGFloat { px / scale(l) }          // tile side in board units
    static func rect(_ l: Int, _ x: Int, _ y: Int, card: CGSize) -> CGRect {
        let t = size(l)
        return CGRect(x: CGFloat(x) * t, y: CGFloat(y) * t, width: t, height: t)
            .intersection(CGRect(origin: .zero, size: card))
    }
    /// Tile indices at level l covering `r` (card-local, y up).
    static func cover(_ l: Int, _ r: CGRect) -> [(Int, Int)] {
        guard !r.isEmpty else { return [] }
        let t = size(l)
        let x0 = Int(floor(r.minX / t)), x1 = Int(ceil(r.maxX / t)) - 1
        let y0 = Int(floor(r.minY / t)), y1 = Int(ceil(r.maxY / t)) - 1
        guard x1 >= x0, y1 >= y0 else { return [] }
        var out: [(Int, Int)] = []
        for y in y0...y1 { for x in x0...x1 { out.append((x, y)) } }
        return out
    }
}

extension Canvas {
    static let tileBudget = 384 * 1024 * 1024

    /// The viewport (optionally grown by `margin` of its size per side) in card i's local coordinates, clipped to the card.
    func localView(_ i: Int, margin: CGFloat) -> CGRect {
        let c = board.cards[i].rect
        let w = bounds.width / z, h = bounds.height / z
        let v = CGRect(x: camX, y: camY, width: w, height: h).insetBy(dx: -w * margin, dy: -h * margin)
        return CGRect(x: v.minX - c.minX, y: c.maxY - v.maxY, width: v.width, height: v.height)
            .intersection(CGRect(origin: .zero, size: c.size))
    }

    func clearTiles() {
        for ct in cardTiles { for t in ct.tiles.values { t.op?.cancel(); t.op = nil; t.layer.removeFromSuperlayer(); t.layer.contents = nil } }
        cardTiles = board.cards.map { _ in CardTiles() }
        tileBytes = 0
    }

    func wantedLevel(_ i: Int) -> Int {
        let target = z * backing
        let cur = cardTiles[i].level
        if let cur, TileGeo.scale(cur) >= target * 0.98, TileGeo.scale(cur) <= target * 4 { return cur }
        return Int(ceil(log2(max(target, 0.25))))
    }

    /// Ask for the tiles the view needs now: viewport tiles first, then the margin.
    func updateTiles() {
        guard mode == 4 else { return }
        let gen = generation
        for i in visible {
            let ct = cardTiles[i]
            let l = wantedLevel(i)
            ct.level = l
            let card = board.cards[i]
            var order = TileGeo.cover(l, localView(i, margin: 0))
            let inner = Set(order.map { CardTiles.key(l, $0.0, $0.1) })
            order += TileGeo.cover(l, localView(i, margin: 0.25)).filter { !inner.contains(CardTiles.key(l, $0.0, $0.1)) }
            for (x, y) in order {
                let k = CardTiles.key(l, x, y)
                if ct.tiles[k] != nil { continue }
                let t = Tile(level: l, x: x, y: y)
                ct.tiles[k] = t
                let r = TileGeo.rect(l, x, y, card: card.rect.size)
                let s = TileGeo.scale(l)
                let g = 1 / s   // one device pixel of overlap on each side hides seams
                let er = r.insetBy(dx: -g, dy: -g)
                let frameless = card.kind == .frameless
                let op = BlockOperation()
                op.addExecutionBlock { [weak self, weak op, weak t, weak ct] in
                    guard let op, !op.isCancelled else { return }
                    let t0 = CACurrentMediaTime()
                    let w = Int(ceil(er.width * s)), h = Int(ceil(er.height * s))
                    guard let surf = Render.surface(width: w, height: h) else { return }
                    Render.withContext(surf) { ctx in
                        ctx.clear(CGRect(x: 0, y: 0, width: w, height: h))
                        ctx.scaleBy(x: s, y: s)
                        ctx.translateBy(x: -er.minX, y: -er.minY)
                        if frameless {  // opaque, so the coarser layers below don't show through the text
                            ctx.setFillColor(Render.boardBg)
                            ctx.fill(er.intersection(CGRect(origin: .zero, size: card.rect.size)))
                        }
                        Render.draw(card, in: ctx)
                    }
                    let ms = (CACurrentMediaTime() - t0) * 1000
                    DispatchQueue.main.async {
                        guard let self, let t, let ct, self.generation == gen, ct.tiles[k] === t, !op.isCancelled else { return }
                        t.op = nil
                        CATransaction.begin(); CATransaction.setDisableActions(true)
                        // exactly the surface's pixels at this level, so the GPU never stretches a tile by a fraction of a pixel
                        t.layer.frame = CGRect(x: er.minX, y: er.minY, width: CGFloat(surf.width) / s, height: CGFloat(surf.height) / s)
                        t.layer.contents = surf
                        t.layer.zPosition = CGFloat(l)  // finer levels above coarser ones
                        self.cardLayers[i].addSublayer(t.layer)
                        CATransaction.commit()
                        t.ready = true
                        t.bytes = surf.allocationSize
                        self.tileBytes += t.bytes
                        if let g = self.gesture { g.rasters += 1; g.rasterMs.append(ms) }
                        self.pruneTiles(i)
                    }
                }
                t.op = op
                pool.addOperation(op)
            }
        }
    }

    /// Old levels go once the current level covers the visible part; tiles far outside go always; then the budget.
    func pruneTiles(_ i: Int) {
        let ct = cardTiles[i]
        guard let l = ct.level else { return }
        let view = localView(i, margin: 0)
        let complete = TileGeo.cover(l, view).allSatisfy { ct.tiles[CardTiles.key(l, $0.0, $0.1)]?.ready == true }
        let keepArea = localView(i, margin: 0.75)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for (k, t) in ct.tiles {
            let r = TileGeo.rect(t.level, t.x, t.y, card: board.cards[i].rect.size)
            let far = !r.intersects(keepArea)
            if (t.level != l && complete) || far { drop(ct, k, t) }
        }
        CATransaction.commit()
    }

    func drop(_ ct: CardTiles, _ k: String, _ t: Tile) {
        t.op?.cancel()
        t.op = nil
        t.layer.removeFromSuperlayer()
        t.layer.contents = nil
        tileBytes -= t.bytes
        ct.tiles.removeValue(forKey: k)
    }

    /// After a gesture: cards out of view lose their tiles; above the budget, the tiles farthest from the view go first.
    func trimTiles() {
        let vis = Set(visible)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for (i, ct) in cardTiles.enumerated() where !vis.contains(i) { for (k, t) in ct.tiles { drop(ct, k, t) } }
        if tileBytes > Canvas.tileBudget {
            let center = CGPoint(x: camX + bounds.width / z / 2, y: camY + bounds.height / z / 2)
            var all: [(CGFloat, CardTiles, String, Tile)] = []
            for (i, ct) in cardTiles.enumerated() {
                let c = board.cards[i].rect
                for (k, t) in ct.tiles {
                    let r = TileGeo.rect(t.level, t.x, t.y, card: c.size)
                    let p = CGPoint(x: c.minX + r.midX, y: c.maxY - r.midY)
                    all.append((hypot(p.x - center.x, p.y - center.y), ct, k, t))
                }
            }
            for (_, ct, k, t) in all.sorted(by: { $0.0 > $1.0 }) where tileBytes > Canvas.tileBudget { drop(ct, k, t) }
        }
        CATransaction.commit()
    }

    /// For the stats: per visible card, is part of its visible area below the current level (shown from an older level
    /// or the fallback), shown from the fallback only, or a mix of levels?
    func tileState() -> (low: Int, fallback: Int, mixed: Int) {
        var low = 0, fb = 0, mixed = 0
        for i in visible {
            let ct = cardTiles[i]
            let l = wantedLevel(i)
            let view = localView(i, margin: 0)
            let cover = TileGeo.cover(l, view)
            let missing = cover.filter { ct.tiles[CardTiles.key(l, $0.0, $0.1)]?.ready != true }
            if missing.isEmpty { continue }
            low += 1
            if missing.count < cover.count { mixed += 1 }
            let size = board.cards[i].rect.size
            let olderLevels = Set(ct.tiles.values.filter { $0.ready && $0.level != l }.map { $0.level })
            var anyFallback = false
            for (x, y) in missing {
                let r = TileGeo.rect(l, x, y, card: size).intersection(view)
                let covered = olderLevels.contains { ol in
                    TileGeo.cover(ol, r).allSatisfy { ct.tiles[CardTiles.key(ol, $0.0, $0.1)]?.ready == true }
                }
                if !covered { anyFallback = true; break }
            }
            if anyFallback { fb += 1; if !olderLevels.isEmpty && missing.count == cover.count { mixed += 1 } }
        }
        return (low, fb, mixed)
    }
}

/// The process's physical footprint, as Activity Monitor's "Memory" column shows it.
func physFootprint() -> Int {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
    }
    return kr == KERN_SUCCESS ? Int(info.phys_footprint) : 0
}
