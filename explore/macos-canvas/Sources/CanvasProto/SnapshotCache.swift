import AppKit
import Compression
import CryptoKit
import ImageIO

/// Note snapshots on disk (~/Library/Caches/CodeBoardCanvas/snapshots), keyed by everything that changes their pixels:
/// the Markdown, the card's size and kind, the scale, the text weight, the page build (page.js / page.css / page.html)
/// and the referenced images (path, size, modification time). An unchanged Note at a scale it was drawn at before is
/// read from here off the main thread and never touches a web view. Lossless: raw BGRA compressed with LZFSE (or PNG,
/// for comparison). Bounded: the least recently used files go first.
final class SnapshotCache: @unchecked Sendable {
    static let shared = SnapshotCache()
    enum Format: String { case lzfse, png }

    let dir: URL = {
        let d = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("CodeBoardCanvas/snapshots", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()
    var format: Format = Format(rawValue: ProcessInfo.processInfo.environment["CANVAS_CACHEFMT"] ?? "") ?? .lzfse
    var budget = 1024 * 1024 * 1024
    var enabled = ProcessInfo.processInfo.environment["CANVAS_DISKCACHE"] != "0"
    private let io = DispatchQueue(label: "snapshot-cache", qos: .userInitiated, attributes: .concurrent)
    private let lock = NSLock()
    private(set) var hits = 0, misses = 0
    private(set) var readMs: [Double] = []

    /// The page build: what the Note page draws with.
    lazy var pageHash: String = {
        var h = SHA256()
        if let page = NoteWeb.pageURL {
            let dir = page.deletingLastPathComponent()
            for f in ["page.html", "page.js", "page.css"] {
                if let d = try? Data(contentsOf: dir.appendingPathComponent(f)) { h.update(data: d) }
            }
        }
        return h.finalize().map { String(format: "%02x", $0) }.joined()
    }()

    func key(card c: Card, scale: CGFloat, viaEditor: Bool, stroke: CGFloat, look: String) -> String {
        var h = SHA256()
        func add(_ s: String) { h.update(data: Data((s + "\u{1}").utf8)) }
        add(pageHash); add(c.body); add(c.kind == .note ? "card" : "plain")
        add(String(format: "%.3f %.3f %.4f %.3f", c.rect.width, c.rect.height, scale, stroke))
        add(viaEditor ? "editor" : "static"); add(look)
        for path in Render.imagePaths(in: c.body, vault: Card.vault) {
            let a = try? FileManager.default.attributesOfItem(atPath: path)
            add("\(path) \((a?[.size] as? Int) ?? -1) \((a?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0)")
        }
        return h.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func url(_ key: String) -> URL { dir.appendingPathComponent("\(key).\(format.rawValue)") }

    /// Reads a snapshot into an IOSurface, off the main thread; nil when there is none.
    func read(_ key: String, done: @escaping (IOSurface?) -> Void) {
        guard enabled else { done(nil); return }
        io.async { [self] in
            let t0 = CACurrentMediaTime()
            let u = url(key)
            guard let data = try? Data(contentsOf: u), let surf = decode(data) else {
                lock.lock(); misses += 1; lock.unlock()
                done(nil); return
            }
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: u.path)  // recently used
            lock.lock(); hits += 1; readMs.append((CACurrentMediaTime() - t0) * 1000); lock.unlock()
            done(surf)
        }
    }

    func write(_ key: String, _ img: CGImage) {
        guard enabled else { return }
        io.async(flags: .barrier) { [self] in
            guard let data = encode(img) else { return }
            try? data.write(to: url(key), options: .atomic)
            trim()
        }
    }

    var size: Int {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return files.reduce(0) { $0 + ((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
    }

    var count: Int { ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).count }

    func clear() {
        for f in (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] { try? FileManager.default.removeItem(at: f) }
    }

    private func trim() {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys) else { return }
        var entries = files.compactMap { u -> (URL, Int, Date)? in
            guard let v = try? u.resourceValues(forKeys: Set(keys)) else { return nil }
            return (u, v.fileSize ?? 0, v.contentModificationDate ?? .distantPast)
        }
        var total = entries.reduce(0) { $0 + $1.1 }
        guard total > budget else { return }
        entries.sort { $0.2 < $1.2 }
        for e in entries where total > budget { try? FileManager.default.removeItem(at: e.0); total -= e.1 }
    }

    // MARK: formats

    func encode(_ img: CGImage) -> Data? {
        switch format {
        case .png:
            let out = NSMutableData()
            guard let d = CGImageDestinationCreateWithData(out, "public.png" as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(d, img, nil)
            return CGImageDestinationFinalize(d) ? out as Data : nil
        case .lzfse:
            let w = img.width, h = img.height
            var raw = [UInt8](repeating: 0, count: w * h * 4)
            raw.withUnsafeMutableBytes { buf in
                let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                    space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                    bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
                ctx?.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
            }
            var out = Data(capacity: raw.count / 4 + 16)
            var header = [UInt32(w), UInt32(h)]
            out.append(Data(bytes: &header, count: 8))
            let dst = UnsafeMutablePointer<UInt8>.allocate(capacity: raw.count + 4096)
            defer { dst.deallocate() }
            let n = compression_encode_buffer(dst, raw.count + 4096, raw, raw.count, nil, COMPRESSION_LZFSE)
            guard n > 0 else { return nil }
            out.append(dst, count: n)
            return out
        }
    }

    func decode(_ data: Data) -> IOSurface? {
        switch format {
        case .png:
            guard let src = CGImageSourceCreateWithData(data as CFData, nil),
                  let img = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else { return nil }
            return Canvas.surface(from: img)
        case .lzfse:
            guard data.count > 8 else { return nil }
            let w = Int(data.withUnsafeBytes { $0.load(fromByteOffset: 0, as: UInt32.self) })
            let h = Int(data.withUnsafeBytes { $0.load(fromByteOffset: 4, as: UInt32.self) })
            guard w > 0, h > 0, let surf = Render.surface(width: w, height: h) else { return nil }
            surf.lock(options: [], seed: nil)
            defer { surf.unlock(options: [], seed: nil) }
            let rowBytes = w * 4
            if surf.bytesPerRow == rowBytes {
                let n = data.withUnsafeBytes { src in
                    compression_decode_buffer(surf.baseAddress.assumingMemoryBound(to: UInt8.self), rowBytes * h,
                                              src.baseAddress!.advanced(by: 8).assumingMemoryBound(to: UInt8.self), data.count - 8, nil, COMPRESSION_LZFSE)
                }
                return n == rowBytes * h ? surf : nil
            }
            var raw = [UInt8](repeating: 0, count: rowBytes * h)
            let n = data.withUnsafeBytes { src in
                compression_decode_buffer(&raw, raw.count, src.baseAddress!.advanced(by: 8).assumingMemoryBound(to: UInt8.self), data.count - 8, nil, COMPRESSION_LZFSE)
            }
            guard n == raw.count else { return nil }
            for y in 0..<h {
                raw.withUnsafeBytes { r in
                    surf.baseAddress.advanced(by: y * surf.bytesPerRow).copyMemory(from: r.baseAddress!.advanced(by: y * rowBytes), byteCount: rowBytes)
                }
            }
            return surf
        }
    }
}
