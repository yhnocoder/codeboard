import AppKit
import ImageIO

/// One image file, decoded at power-of-two widths ("levels") into IOSurfaces, off the main thread.
final class ImageItem {
    let path: String
    let isSVG: Bool
    let pixelSize: CGSize       // raster: the file's pixels; SVG: its size in points
    var levels: [Int: IOSurface] = [:]
    var pending: [Int: [(IOSurface?) -> Void]] = [:]

    init(path: String, size: CGSize) {
        self.path = path; pixelSize = size; isSVG = path.lowercased().hasSuffix(".svg")
    }

    /// Largest width worth decoding: the file's own pixels (an SVG can go further).
    var cap: Int { isSVG ? 8192 : Int(pixelSize.width) }

    func level(for px: CGFloat) -> Int {
        var l = 128
        while CGFloat(l) < px && l < cap { l *= 2 }
        return min(l, cap)
    }

    var bytes: Int { levels.values.reduce(0) { $0 + $1.allocationSize } }
}

/// Where one image shows on the board: its own layer in world coordinates, with the level it currently shows.
final class ImageSlot {
    let item: ImageItem
    let rect: CGRect            // board coordinates, y down
    let layer = CALayer()
    var level = 0               // 0 = nothing decoded yet (only before the first decode of a board's first open)
    var inFlight = false

    init(item: ImageItem, rect: CGRect) {
        self.item = item; self.rect = rect
        layer.anchorPoint = .zero
        layer.frame = CGRect(x: rect.minX, y: -rect.maxY, width: rect.width, height: rect.height)
        layer.contentsGravity = .resize
        layer.minificationFilter = .trilinear
        layer.backgroundColor = CGColor(srgbRed: 0.93, green: 0.92, blue: 0.89, alpha: 1)  // until the first decode only
        layer.actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull(), "backgroundColor": NSNull()]
    }
}

final class ImageStore {
    var items: [String: ImageItem] = [:]
    var generation = 0
    let queue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = max(2, ProcessInfo.processInfo.activeProcessorCount / 2)
        q.qualityOfService = .userInitiated
        return q
    }()
    /// Decode times (ms) since the last read.
    var decodeMs: [Double] = []

    /// Pixel size from the file name (`<hash>-<w>x<h>.<ext>`), else from the header (no decode).
    static func pixelSize(_ path: String) -> CGSize? {
        let name = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
        if let dash = name.lastIndex(of: "-") {
            let dims = name[name.index(after: dash)...].split(separator: "x")
            if dims.count == 2, let w = Double(dims[0]), let h = Double(dims[1]) { return CGSize(width: w, height: h) }
        }
        if path.lowercased().hasSuffix(".svg") { return NSImage(contentsOfFile: path)?.size }
        guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let w = p[kCGImagePropertyPixelWidth] as? Double, let h = p[kCGImagePropertyPixelHeight] as? Double
        else { return nil }
        return CGSize(width: w, height: h)
    }

    func item(_ path: String) -> ImageItem? {
        if let i = items[path] { return i }
        guard FileManager.default.fileExists(atPath: path), let size = ImageStore.pixelSize(path) else { return nil }
        let i = ImageItem(path: path, size: size)
        items[path] = i
        return i
    }

    var bytes: Int { items.values.reduce(0) { $0 + $1.bytes } }

    /// The surface at `level`, decoded off the main thread if needed; `done` runs on the main thread.
    func request(_ item: ImageItem, level: Int, done: @escaping (IOSurface?) -> Void) {
        if let s = item.levels[level] { done(s); return }
        if item.pending[level] != nil { item.pending[level]!.append(done); return }
        item.pending[level] = [done]
        let gen = generation
        queue.addOperation { [weak self] in
            let t0 = CACurrentMediaTime()
            let s = ImageStore.decode(item, width: level)
            let ms = (CACurrentMediaTime() - t0) * 1000
            DispatchQueue.main.async {
                guard let self, self.generation == gen else { return }
                self.decodeMs.append(ms)
                if let s { item.levels[level] = s }
                let waiting = item.pending.removeValue(forKey: level) ?? []
                waiting.forEach { $0(s) }
            }
        }
    }

    /// Drops every level of `item` except those in `keep`.
    func trim(_ item: ImageItem, keep: Set<Int>) {
        for l in item.levels.keys where !keep.contains(l) { item.levels.removeValue(forKey: l) }
    }

    static func decode(_ item: ImageItem, width: Int) -> IOSurface? {
        let aspect = item.pixelSize.height / max(item.pixelSize.width, 1)
        let w = width, h = max(1, Int((CGFloat(width) * aspect).rounded()))
        if item.isSVG {
            guard let img = NSImage(contentsOfFile: item.path), let s = Render.surface(width: w, height: h) else { return nil }
            Render.withContext(s) { ctx in
                ctx.setFillColor(CGColor(gray: 1, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
                img.draw(in: NSRect(x: 0, y: 0, width: w, height: h))
                NSGraphicsContext.restoreGraphicsState()
            }
            return s
        }
        guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: item.path) as CFURL, nil) else { return nil }
        let full = width >= Int(item.pixelSize.width)
        let opts: [CFString: Any] = [
            kCGImageSourceThumbnailMaxPixelSize: max(w, h),
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        let cg = full ? CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
            : CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
        guard let cg, let s = Render.surface(width: cg.width, height: cg.height) else { return nil }
        Render.withContext(s) { ctx in
            ctx.clear(CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        }
        return s
    }
}
