import AppKit
import CoreText

/// Warm Ink light, and how one card is drawn. Everything here is thread-safe: it only reads immutable card data.
enum Render {
    static let boardBg = CGColor(srgbRed: 0xee / 255, green: 0xec / 255, blue: 0xe6 / 255, alpha: 1)
    static let cardBg = CGColor(srgbRed: 0xfd / 255, green: 0xfc / 255, blue: 0xfa / 255, alpha: 1)
    static let headerBg = CGColor(srgbRed: 0xf8 / 255, green: 0xf6 / 255, blue: 0xf1 / 255, alpha: 1)
    static let ink = CGColor(srgbRed: 0x21 / 255, green: 0x1f / 255, blue: 0x1b / 255, alpha: 1)
    static let ink2 = CGColor(srgbRed: 0x62 / 255, green: 0x5e / 255, blue: 0x56 / 255, alpha: 1)
    static let hairline = CGColor(srgbRed: 60 / 255, green: 45 / 255, blue: 20 / 255, alpha: 0.16)

    static let mono = CTFontCreateWithName("SFMono-Regular" as CFString, 11, nil)
    static let sans = CTFontCreateWithName(".AppleSystemUIFont" as CFString, 13, nil)
    static let titleFont = CTFontCreateWithName(".AppleSystemUIFontDemi" as CFString, 11.5, nil)

    static func attrs(_ font: CTFont, _ color: CGColor, lineHeight: CGFloat) -> [NSAttributedString.Key: Any] {
        let ps = NSMutableParagraphStyle()
        ps.minimumLineHeight = lineHeight; ps.maximumLineHeight = lineHeight
        ps.lineBreakMode = .byWordWrapping
        return [.font: font, .foregroundColor: color, .paragraphStyle: ps]
    }

    static func bodyRect(_ c: Card) -> CGRect {  // local, y up, origin bottom-left of the card
        let top = c.kind == .code || c.kind == .board ? Board.header : 0
        return CGRect(x: Board.pad, y: Board.pad, width: c.rect.width - 2 * Board.pad,
                      height: max(c.rect.height - top - 2 * Board.pad, 1))
    }

    static let imageRef = try! NSRegularExpression(pattern: #"!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)"#)

    /// Lays the body out once: text blocks and images stacked top to bottom (images at most the body width and their
    /// own pixel width). Cards without a stored height get one from their content.
    static func layout(_ c: Card, vault: String) {
        if c.kind == .image {
            if c.rect.height == 0 { c.rect.size.height = 120 }
            if let p = c.imagePath { c.images = [(p, c.rect.insetBy(dx: 1, dy: 1))] }
            return
        }
        let top = c.kind == .code || c.kind == .board ? Board.header : 0
        let width = c.rect.width - 2 * Board.pad
        let attrs = c.kind == .code ? attrs(mono, ink, lineHeight: 16) : attrs(sans, ink, lineHeight: 20)
        // Blocks in card-local y-down offsets from the body top.
        enum Block { case text(CTFramesetter, CGFloat), image(String, CGSize) }
        var blocks: [Block] = []
        func addText(_ t: String) {
            let t = t.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty else { return }
            let fs = CTFramesetterCreateWithAttributedString(NSAttributedString(string: t, attributes: attrs))
            let fit = CTFramesetterSuggestFrameSizeWithConstraints(fs, CFRange(), nil, CGSize(width: width, height: .greatestFiniteMagnitude), nil)
            blocks.append(.text(fs, ceil(fit.height) + 2))
        }
        if c.kind == .code {
            addText(c.body)
        } else {
            let ns = c.body as NSString
            var at = 0
            for m in imageRef.matches(in: c.body, range: NSRange(location: 0, length: ns.length)) {
                addText(ns.substring(with: NSRange(location: at, length: m.range.location - at)))
                let ref = ns.substring(with: m.range(at: 1))
                let path = ref.hasPrefix("assets/") ? "\(vault)/\(ref)" : "\(vault)/assets/\(ref)"
                if let px = ImageStore.pixelSize(path), px.width > 0 {
                    let w = min(width, px.width)
                    blocks.append(.image(path, CGSize(width: w, height: w * px.height / px.width)))
                }
                at = m.range.location + m.range.length
            }
            addText(ns.substring(from: at))
        }
        let gap: CGFloat = 8
        let content = blocks.reduce(CGFloat(0)) { acc, b in
            switch b { case .text(_, let h): return acc + h + gap; case .image(_, let s): return acc + s.height + gap }
        }
        if c.rect.height == 0 { c.rect.size.height = min(content + top + 2 * Board.pad, Board.maxAutoHeight) }
        let H = c.rect.height
        var y = top + Board.pad  // y-down offset of the next block
        for b in blocks {
            if y > H { break }
            switch b {
            case .text(let fs, let h):
                let r = CGRect(x: Board.pad, y: H - y - h, width: width, height: h)  // y up
                c.frames.append(CTFramesetterCreateFrame(fs, CFRange(), CGPath(rect: r, transform: nil), nil))
                y += h + gap
            case .image(let path, let size):
                c.images.append((path, CGRect(x: c.rect.minX + Board.pad, y: c.rect.minY + y, width: size.width, height: size.height)))
                y += size.height + gap
            }
        }
    }

    /// Draws the card into ctx in card-local board units (y up, origin at the card's bottom-left).
    static func draw(_ c: Card, in ctx: CGContext, images: [CGImage?] = []) {
        let r = CGRect(origin: .zero, size: c.rect.size)
        ctx.textMatrix = .identity
        if c.kind != .frameless {
            let p = CGPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), cornerWidth: 7, cornerHeight: 7, transform: nil)
            ctx.addPath(p); ctx.setFillColor(cardBg); ctx.fillPath()
            if c.kind == .code || c.kind == .board {
                ctx.saveGState(); ctx.addPath(p); ctx.clip()
                ctx.setFillColor(headerBg); ctx.fill(CGRect(x: 0, y: r.height - Board.header, width: r.width, height: Board.header))
                ctx.setFillColor(hairline); ctx.fill(CGRect(x: 0, y: r.height - Board.header, width: r.width, height: 1))
                ctx.restoreGState()
                let t = NSAttributedString(string: c.title, attributes: attrs(titleFont, ink2, lineHeight: 14))
                let line = CTLineCreateWithAttributedString(t)
                let trunc = CTLineCreateTruncatedLine(line, Double(r.width - 2 * Board.pad), .end,
                                                      CTLineCreateWithAttributedString(NSAttributedString(string: "…", attributes: attrs(titleFont, ink2, lineHeight: 14)))) ?? line
                ctx.textPosition = CGPoint(x: Board.pad, y: r.height - Board.header + 8.5)
                CTLineDraw(trunc, ctx)
            }
            ctx.addPath(p); ctx.setStrokeColor(hairline); ctx.setLineWidth(1); ctx.strokePath()
        }
        if !c.frames.isEmpty {
            ctx.saveGState(); ctx.clip(to: bodyRect(c)); c.frames.forEach { CTFrameDraw($0, ctx) }; ctx.restoreGState()
        }
        // pictures (mode 5 draws them into the card's bitmap instead of separate image layers)
        for (k, im) in c.images.enumerated() where k < images.count {
            guard let img = images[k] else { continue }
            let local = CGRect(x: im.rect.minX - c.rect.minX, y: c.rect.maxY - im.rect.maxY, width: im.rect.width, height: im.rect.height)
            ctx.saveGState()
            ctx.addPath(c.kind == .image ? CGPath(roundedRect: local, cornerWidth: 6, cornerHeight: 6, transform: nil)
                                         : CGPath(rect: local.intersection(CGRect(origin: .zero, size: c.rect.size)), transform: nil))
            ctx.clip()
            ctx.interpolationQuality = .high
            ctx.draw(img, in: local)
            ctx.restoreGState()
        }
    }

    /// The pictures card c needs at `scale` device px per board unit (blocks: background threads only).
    static func pictures(_ c: Card, scale: CGFloat) -> [CGImage?] {
        c.images.map { ImageCache.shared.image($0.path, width: Int(ceil($0.rect.width * scale))) }
    }

    /// A bitmap of the card at `scale` device pixels per board unit (capped so one card stays below ~64 MB).
    static let maxSide: CGFloat = 16384, maxPixels: CGFloat = 16_000_000
    static func cappedScale(_ c: Card, _ scale: CGFloat) -> CGFloat {
        var s = min(scale, maxSide / max(c.rect.width, c.rect.height))
        let px = c.rect.width * c.rect.height * s * s
        if px > maxPixels { s *= sqrt(maxPixels / px) }
        return s
    }

    /// Same bitmap, drawn into an IOSurface that a layer can show without a copy at commit.
    static func surface(width w: Int, height h: Int) -> IOSurface? {
        IOSurface(properties: [.width: w, .height: h, .bytesPerElement: 4, .pixelFormat: 0x42475241 /* 'BGRA' */])
    }

    static func withContext(_ s: IOSurface, _ body: (CGContext) -> Void) {
        s.lock(options: [], seed: nil)
        defer { s.unlock(options: [], seed: nil) }
        guard let ctx = CGContext(data: s.baseAddress, width: s.width, height: s.height, bitsPerComponent: 8, bytesPerRow: s.bytesPerRow,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return }
        ctx.setShouldSmoothFonts(false)
        body(ctx)
    }

    static func rasterSurface(_ c: Card, scale: CGFloat, images: [CGImage?] = []) -> IOSurface? {
        let w = Int(ceil(c.rect.width * scale)), h = Int(ceil(c.rect.height * scale))
        guard w > 0, h > 0, let s = surface(width: w, height: h) else { return nil }
        withContext(s) { ctx in ctx.clear(CGRect(x: 0, y: 0, width: w, height: h)); ctx.scaleBy(x: scale, y: scale); draw(c, in: ctx, images: images) }
        return s
    }

    static func raster(_ c: Card, scale: CGFloat) -> CGImage? {
        let w = Int(ceil(c.rect.width * scale)), h = Int(ceil(c.rect.height * scale))
        guard w > 0, h > 0, let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                                 space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                                 bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return nil }
        ctx.setShouldSmoothFonts(false)
        ctx.scaleBy(x: scale, y: scale)
        draw(c, in: ctx)
        return ctx.makeImage()
    }
}
