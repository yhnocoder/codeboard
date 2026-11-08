// Arrow routing off the main thread: a second JavaScript context (its own virtual machine) running only core's routing
// (dist/router.js, js/router-entry.ts) on a thread of its own (a `JSThread`, where the context is made). During a drag the canvas posts the moved cards' rectangles every frame;
// requests coalesce (a new one replaces the one not started yet, so the routes drawn are never older than one request behind),
// and each finished set of routes comes back on the main thread with its request number. The drop's final route goes through the
// main session as before; the models come from each Scene / SceneChange (`routing`).
import Foundation
import JavaScriptCore

final class RouteWorker {
  private var ctx: JSContext!
  private let js = JSThread("codeboard.route")
  private var api: JSValue { ctx.objectForKeyedSubscript("CodeRouter") }
  private var pending: (key: String, rects: String, only: String, seq: Int, cb: ([RouteGeo], Int) -> Void)?
  private var busy = false

  init(bundle: URL) throws {
    let src = try String(contentsOf: bundle, encoding: .utf8)
    // made and loaded on its thread: the first route waits on it, the main thread does not
    js.post { [self] in
      ctx = JSContext(virtualMachine: JSVirtualMachine()!)!
      ctx.exceptionHandler = { _, e in logLine("[codeboard router] %@", e?.toString() ?? "?") }
      ctx.evaluateScript(src, withSourceURL: bundle)
      if api.isUndefined { logLine("[codeboard] router.js did not define CodeRouter") }
    }
  }

  /** The board's routing model (links, each card's kind and code rows); key = folder + board */
  func setModel(_ key: String, _ json: String) { js.post { [self] in api.invokeMethod("setModel", withArguments: [key, json]) } }
  func drop(_ key: String) { js.post { [self] in api.invokeMethod("drop", withArguments: [key]) } }
  func setLook(_ look: String) { js.post { [self] in api.invokeMethod("setLook", withArguments: [look]) } }

  /** Routes for these rectangles (only the links named); cb on the main thread with `seq`. A request made while one runs waits,
   *  and a newer one replaces it: at most one finished and one waiting at any time */
  func route(_ key: String, rects: [String: WorldRect], only: [String], seq: Int, _ cb: @escaping ([RouteGeo], Int) -> Void) {
    pending = (key, encodeJSON(rects), encodeJSON(only), seq, cb)
    pump()
  }
  private func pump() {
    guard !busy, let p = pending else { return }
    pending = nil
    busy = true
    js.post { [self] in
      let r = api.invokeMethod("route", withArguments: [p.key, p.rects, p.only])?.toString() ?? "[]"
      let geos = (try? decodeJSON([RouteGeo].self, r)) ?? []
      DispatchQueue.main.async {
        self.busy = false
        p.cb(geos, p.seq)
        self.pump()
      }
    }
  }
}
