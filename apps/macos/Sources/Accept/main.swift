// The acceptance driver around the CodeBoard app (apps/macos/tools/accept/README.md; the driver is AcceptKit): the board
// point a target names is placed through the canvas's camera, and a vault is imported from the storage folder first
import AcceptKit
import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardShell

/// A point in the window's content view as the driver takes it: from the top left, flipped or not
@MainActor func topLeft(_ p: NSPoint, in cv: NSView) -> NSPoint {
  cv.isFlipped ? p : NSPoint(x: p.x, y: cv.bounds.height - p.y)
}

@MainActor func canvas(_ w: NSWindow) -> CanvasView? {
  func find(_ v: NSView) -> CanvasView? { (v as? CanvasView) ?? v.subviews.lazy.compactMap(find).first }
  return w.contentView.flatMap(find)
}

MainActor.assumeIsolated {
  runDriver(
    DriverHost(
      place: { x, y, w in
        guard let c = canvas(w), let cv = w.contentView else { return nil }
        let cam = c.currentCamera
        let vp = NSPoint(x: (x - cam.origin.x) * cam.zoom, y: (y - cam.origin.y) * cam.zoom)
        return topLeft(cv.convert(c.convert(vp, to: nil), from: nil), in: cv)
      },
      camera: { w in
        guard let c = canvas(w), let cv = w.contentView else { return nil }
        let cam = c.currentCamera
        let mid = topLeft(
          cv.convert(c.convert(NSPoint(x: c.bounds.midX, y: c.bounds.midY), to: nil), from: nil), in: cv)
        return String(format: "%.2f %.2f %.4f %.1f %.1f", cam.origin.x, cam.origin.y, cam.zoom, mid.x, mid.y)
      },
      launch: {
        let env = ProcessInfo.processInfo.environment
        if let from = env["ACCEPT_IMPORT_FROM"], let to = env["ACCEPT_VAULT"] {
          do {
            let r = try LegacyImport.run(from: URL(filePath: from), to: URL(filePath: to))
            log("imported: \(r.imported.count) boards, \(r.failed.count) failed")
          } catch { log("import failed: \(error)") }
        }
        runApp()
      }))
}
