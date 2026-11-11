import AppKit
import ImageIO

/// Decoded pictures for drawing into card bitmaps (mode 5: one pipeline for text and images). Keeps the largest decode
/// of each file; a request for a smaller width reuses it, a larger one decodes again at a power-of-two width (capped at
/// the file's own pixels; SVG is drawn by WebKit and has no cap below 8192). Safe to call from any thread.
final class ImageCache: @unchecked Sendable {
    static let shared = ImageCache()
    private let lock = NSLock()
    private var images: [String: CGImage] = [:]
    private(set) var decodeMs: [Double] = []

    var bytes: Int {
        lock.lock(); defer { lock.unlock() }
        return images.values.reduce(0) { $0 + $1.bytesPerRow * $1.height }
    }

    func clear() { lock.lock(); images = [:]; lock.unlock() }

    /// A picture of `path` at least `width` pixels wide (or as wide as the file is), decoding if needed. Blocks the
    /// calling thread (a background redraw); never call it on the main thread for an SVG.
    func image(_ path: String, width: Int) -> CGImage? {
        let isSVG = path.lowercased().hasSuffix(".svg")
        let size = ImageStore.pixelSize(path) ?? CGSize(width: width, height: width)
        let cap = isSVG ? 8192 : Int(size.width)
        var level = 128
        while level < width && level < cap { level *= 2 }
        level = min(level, cap)
        lock.lock()
        if let have = images[path], have.width >= level || have.width >= cap { lock.unlock(); return have }
        lock.unlock()
        let t0 = CACurrentMediaTime()
        let img = isSVG ? decodeSVG(path, size: size, width: level) : decodeRaster(path, size: size, width: level)
        lock.lock()
        decodeMs.append((CACurrentMediaTime() - t0) * 1000)
        if let img, (images[path]?.width ?? 0) < img.width { images[path] = img }
        let out = images[path]
        lock.unlock()
        return out
    }

    private func decodeRaster(_ path: String, size: CGSize, width: Int) -> CGImage? {
        guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
        if width >= Int(size.width) {
            return CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        }
        let h = Int((CGFloat(width) * size.height / max(size.width, 1)).rounded())
        return CGImageSourceCreateThumbnailAtIndex(src, 0, [
            kCGImageSourceThumbnailMaxPixelSize: max(width, h),
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary)
    }

    /// WebKit draws the SVG (NSImage ignores its <style>); the web view lives on the main thread, so wait for it.
    private func decodeSVG(_ path: String, size: CGSize, width: Int) -> CGImage? {
        guard let raster = ImageStore.svgRaster else { return nil }
        let done = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var out: CGImage?
        Task { @MainActor in
            out = await raster(path, size, width)
            done.signal()
        }
        _ = done.wait(timeout: .now() + 5)
        return out
    }
}
