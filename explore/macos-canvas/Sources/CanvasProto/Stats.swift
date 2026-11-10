import Foundation

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
        return s + busy
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
