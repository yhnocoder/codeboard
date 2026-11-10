import Foundation
import CoreGraphics

/// What one gesture (a continuous camera motion) measured.
final class GestureStats {
    let label: String
    let mode: Int
    let refresh: Double
    var intervals: [Double] = []  // seconds between display link callbacks while the camera moved
    var lowAny = 0.0              // seconds during which at least one visible card was below display resolution
    var lowCard = 0.0             // card-seconds below display resolution
    var visCard = 0.0             // card-seconds visible
    var maxVisible = 0
    var rasters = 0
    var rasterMs: [Double] = []
    var drawMs: [Double] = []
    var busyMs: [Double] = []
    var maxImages = 0
    var imgLowAny = 0.0, imgLow = 0.0, imgVis = 0.0, imgBlank = 0.0
    var decodeMs: [Double] = []
    var zoomAtEnd: CGFloat = 0
    var imgBytes = 0, cardBytes = 0
    var presented: [Double] = []  // presentation times of the probe's drawables (0 = not presented)
    var probeMissed = 0
    var maxStep: CGFloat = 0, maxSpeed: CGFloat = 0
    var fallbackAny = 0.0, mixedAny = 0.0, fallbackCards = 0
    var peakWeb = 0
    var peakCard = 0, peakImg = 0, peakFootprint = 0, footprint = 0
    var settleMs: Double?         // motion end → every visible card sharp again
    var motionEnd: Double?

    init(label: String, mode: Int, refresh: Double) { self.label = label; self.mode = mode; self.refresh = refresh }

    var dropped: Int { intervals.reduce(0) { $0 + max(0, Int(($1 / refresh).rounded()) - 1) } }
    var expectedFrames: Int { intervals.reduce(0) { $0 + max(1, Int(($1 / refresh).rounded())) } }

    static func pct(_ a: [Double], _ p: Double) -> Double {
        guard !a.isEmpty else { return 0 }
        let s = a.sorted()
        return s[min(s.count - 1, Int(Double(s.count - 1) * p + 0.5))]
    }

    func summary(board: String) -> String {
        let ms = intervals.map { $0 * 1000 }
        let busy = String(format: " busy_p50=%.2fms busy_p95=%.2fms busy_max=%.2fms",
                          GestureStats.pct(busyMs, 0.5), GestureStats.pct(busyMs, 0.95), busyMs.max() ?? 0)
        defer { _ = busy }
        var s = String(format: "%@ mode=%@ board=%@ frames=%d p50=%.2fms p95=%.2fms max=%.2fms dropped=%d/%d visible<=%d",
                       label, Canvas.modeNames[mode] ?? "?", board, ms.count, GestureStats.pct(ms, 0.5), GestureStats.pct(ms, 0.95),
                       ms.max() ?? 0, dropped, expectedFrames, maxVisible)
        if mode != 3 {
            s += String(format: " lowres_any=%.0fms lowres_cards=%.0f%% settle=%@ rasters=%d raster_p50=%.1fms raster_max=%.1fms",
                        lowAny * 1000, visCard > 0 ? lowCard / visCard * 100 : 0,
                        settleMs.map { String(format: "%.0fms", $0) } ?? "interrupted", rasters,
                        GestureStats.pct(rasterMs, 0.5), rasterMs.max() ?? 0)
        } else {
            s += String(format: " draw_p50=%.2fms draw_p95=%.2fms draw_max=%.2fms",
                        GestureStats.pct(drawMs, 0.5), GestureStats.pct(drawMs, 0.95), drawMs.max() ?? 0)
        }
        s += busy
        let pt = presented.filter { $0 > 0 }.sorted()
        let piv = zip(pt.dropFirst(), pt).map { $0 - $1 }
        let pdrop = piv.reduce(0) { $0 + max(0, Int(($1 / refresh).rounded()) - 1) }
        s += String(format: " presented=%d/%d presented_p95=%.2fms presented_max=%.2fms presented_dropped=%d",
                    pt.count, presented.count + probeMissed, GestureStats.pct(piv.map { $0 * 1000 }, 0.95),
                    (piv.max() ?? 0) * 1000, pdrop)
        s += String(format: " images<=%d img_lowres_any=%.0fms img_lowres=%.0f%% img_blank=%.0fms decodes=%d decode_p50=%.1fms decode_max=%.1fms zoom_end=%.2f img_mem=%.1fMB card_mem=%.1fMB",
                    maxImages, imgLowAny * 1000, imgVis > 0 ? imgLow / imgVis * 100 : 0, imgBlank * 1000, decodeMs.count,
                    GestureStats.pct(decodeMs, 0.5), decodeMs.max() ?? 0, zoomAtEnd, Double(imgBytes) / 1e6, Double(cardBytes) / 1e6)
        s += String(format: " max_step=%.0fpt peak_speed=%.0fpt/s", maxStep, maxSpeed)
        s += String(format: " fallback_any=%.0fms mixed_any=%.0fms peak_card_mem=%.1fMB peak_img_mem=%.1fMB footprint=%.0fMB peak_footprint=%.0fMB",
                    fallbackAny * 1000, mixedAny * 1000, Double(peakCard) / 1e6, Double(peakImg) / 1e6,
                    Double(footprint) / 1e6, Double(max(peakFootprint, footprint)) / 1e6)
        s += String(format: " peak_web_mem=%.0fMB", Double(peakWeb) / 1e6)
        return s
    }
}

enum Log {
    static let url: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs")
        return dir.appendingPathComponent("CodeBoardCanvas.log")
    }()

    static func write(_ line: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        let text = "\(stamp) \(line)\n"
        print(text, terminator: "")
        fflush(stdout)
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile(); h.write(text.data(using: .utf8)!); try? h.close()
        } else {
            try? text.data(using: .utf8)!.write(to: url)
        }
    }
}
