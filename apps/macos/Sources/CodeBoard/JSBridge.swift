// The JavaScript side (dist/bridge.js: @codeboard/core and the host's Storage, see js/bridge.ts) in JavaScriptCore: one context
// for the whole process (the app delegate's), with one Storage per boards folder (`Folder`, shared by every window on it) and one
// session per open board (`Session`, a window is a view onto it). This is the shell's `native` (js/native.ts: a synchronous file
// system, timers, FSEvents for the storage folder) and the typed calls into `CodeBoard`. An actor: the context, its virtual
// machine and everything JavaScript touches (native callbacks, timers, FSEvents, the pending replies) live on one dedicated thread
// with its own run loop (`JSThread`), where JavaScriptCore also runs its deferred work (a WebAssembly compile's continuation, GC
// timers). The main thread never waits on it: requests are posted, and every reply and event comes back through the main queue in
// the order it happened, tagged with its folder and board, so a window applies only what is for the board it shows.
// apps/macos/ARCHITECTURE.md has the shape.
import AppKit
import CoreServices
import CryptoKit
import JavaScriptCore

/** A thread with a run loop that runs the blocks posted to it, in order */
final class JSThread {
  private var loop: CFRunLoop!
  init(_ name: String) {
    let ready = DispatchSemaphore(value: 0)
    let t = Thread { [self] in
      loop = CFRunLoopGetCurrent()
      RunLoop.current.add(Port(), forMode: .default)  // something to wait on, or the loop would return at once
      ready.signal()
      CFRunLoopRun()
    }
    t.name = name
    t.qualityOfService = .userInitiated
    t.start()
    ready.wait()
  }
  func post(_ block: @escaping () -> Void) {
    CFRunLoopPerformBlock(loop, CFRunLoopMode.defaultMode.rawValue, block)
    CFRunLoopWakeUp(loop)
  }
}

final class JSBridge {
  /** Set on the JavaScript thread by the first posted block; every later use is there too */
  private var ctx: JSContext!
  private let js = JSThread("codeboard.js")
  private var api: JSValue { ctx.objectForKeyedSubscript("CodeBoard") }
  private var pending: [Int: (Result<String, Error>) -> Void] = [:]
  private var nextReq = 1
  private var timers: [Int: Timer] = [:]
  private var watches: [Int: FSEventStreamRef] = [:]
  private var nextWatch = 1
  /** Events not for a folder (none today; a folder's go to its Folder's listeners) */
  var onEvent: ((String, String) -> Void)?
  struct JSError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
  }

  init(bundle: URL, resources: URL) throws {
    let src = try String(contentsOf: bundle, encoding: .utf8)
    js.post { [self] in
      ctx = JSContext()!
      setUp(resources)
      let t0 = CACurrentMediaTime()
      ctx.evaluateScript(src, withSourceURL: bundle)
      logLine("[codeboard] bridge.js evaluated in %.0f ms", (CACurrentMediaTime() - t0) * 1000)
      if api.isUndefined { logLine("[codeboard] bridge.js did not define CodeBoard") }
    }
  }
  /** On the JavaScript thread: the shell's `native` */
  private func setUp(_ resources: URL) {
    ctx.exceptionHandler = { [weak self] _, e in
      let text = e?.toString() ?? "?"
      logLine("[codeboard js] %@", text)
      self?.lastError = text
    }
    let native = JSValue(newObjectIn: ctx)!
    func put(_ name: String, _ block: Any) { native.setObject(block, forKeyedSubscript: name as NSString) }
    let fm = FileManager.default
    func err(_ e: Error) -> [String: Any] { ["error": (e as NSError).localizedDescription] }
    put("readdir", { (dir: String) -> Any in
      do {
        return try fm.contentsOfDirectory(atPath: dir).map { name -> [String: Any] in
          var isDir: ObjCBool = false
          fm.fileExists(atPath: (dir as NSString).appendingPathComponent(name), isDirectory: &isDir)
          return ["name": name, "isFile": !isDir.boolValue, "isDir": isDir.boolValue]
        }
      } catch { return err(error) }
    } as @convention(block) (String) -> Any)
    put("stat", { (p: String) -> Any in
      do {
        let a = try fm.attributesOfItem(atPath: p)
        let ms = { (k: FileAttributeKey) -> Double in ((a[k] as? Date)?.timeIntervalSince1970 ?? 0) * 1000 }
        return ["mtimeMs": ms(.modificationDate), "birthtimeMs": ms(.creationDate), "ctimeMs": ms(.modificationDate)]
      } catch { return err(error) }
    } as @convention(block) (String) -> Any)
    put("readFile", { (p: String) -> Any in
      do { return try String(contentsOfFile: p, encoding: .utf8) } catch { return err(error) }
    } as @convention(block) (String) -> Any)
    put("readBinary", { (p: String) -> Any in
      do { return try Data(contentsOf: URL(fileURLWithPath: p)).base64EncodedString() } catch { return err(error) }
    } as @convention(block) (String) -> Any)
    // whole or not at all (Storage writes the file another window may be reading); bytes that are not base64 are an error, not an
    // empty file
    put("writeFile", { (p: String, data: String, base64: Bool) -> Any? in
      guard let bytes = base64 ? Data(base64Encoded: data) : Data(data.utf8) else { return ["error": "EBADBASE64: not base64"] }
      do { try bytes.write(to: URL(fileURLWithPath: p), options: .atomic); return nil } catch { return err(error) }
    } as @convention(block) (String, String, Bool) -> Any?)
    // rename(2), as Node's fs.rename: atomic, replaces a file, a folder only when empty (ENOTEMPTY otherwise), and a change of case
    // only is a rename in place, never a delete
    put("rename", { (a: String, b: String) -> Any? in
      Darwin.rename(a, b) == 0 ? nil : ["error": String(cString: strerror(errno))]
    } as @convention(block) (String, String) -> Any?)
    put("camGet", { (id: String) -> Any? in CameraStore.shared.get(id) } as @convention(block) (String) -> Any?)
    put("camSet", { (id: String, json: String) in CameraStore.shared.set(id, json) } as @convention(block) (String, String) -> Void)
    put("rm", { (p: String) -> Any? in
      do { if fm.fileExists(atPath: p) { try fm.removeItem(atPath: p) }; return nil } catch { return err(error) }
    } as @convention(block) (String) -> Any?)
    put("rmdir", { (p: String) -> Any? in
      do {
        if !(try fm.contentsOfDirectory(atPath: p)).isEmpty { return ["error": "ENOTEMPTY"] }
        try fm.removeItem(atPath: p)
        return nil
      } catch { return err(error) }
    } as @convention(block) (String) -> Any?)
    put("mkdir", { (p: String) -> Any? in
      do { try fm.createDirectory(atPath: p, withIntermediateDirectories: true); return nil } catch { return err(error) }
    } as @convention(block) (String) -> Any?)
    put("sha1", { (b64: String) -> String in
      Insecure.SHA1.hash(data: Data(base64Encoded: b64) ?? Data()).map { String(format: "%02x", $0) }.joined()
    } as @convention(block) (String) -> String)
    put("sha256", { (text: String) -> String in
      SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    } as @convention(block) (String) -> String)
    put("readBase64", { (p: String) -> Any in
      do { return try Data(contentsOf: URL(fileURLWithPath: p)).base64EncodedString() } catch { return err(error) }
    } as @convention(block) (String) -> Any)
    put("now", { () -> Double in CACurrentMediaTime() * 1000 } as @convention(block) () -> Double)
    // a command asks the user (core's CommandEnv.choose): an alert once this JavaScript call has returned (never modal inside
    // it), the option's index or null to the callback
    put("choose", { [unowned self] (title: String, options: [String], text: String, done: JSValue) in
      DispatchQueue.main.async { [self] in
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        for o in options { a.addButton(withTitle: o) }  // core's options carry their own Cancel
        let r = a.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        // the answer back on the JavaScript thread: a promise settles, and its jobs run, only there
        js.post { done.call(withArguments: [r >= 0 && r < options.count ? r : NSNull()]) }
      }
    } as @convention(block) (String, [String], String, JSValue) -> Void)
    put("emit", { [unowned self] (name: String, json: String) in self.event(name, json) } as @convention(block) (String, String) -> Void)
    // on this thread's run loop (so they fire whatever the main run loop is in: a sheet, the quit confirmation waiting on a flush)
    put("setTimer", { [unowned self] (id: Int, ms: Double) in
      self.timers[id]?.invalidate()
      let t = Timer(timeInterval: ms / 1000, repeats: false) { [weak self] _ in
        guard let self else { return }
        self.timers[id] = nil
        self.api.invokeMethod("timer", withArguments: [id])
      }
      t.tolerance = ms > 100 ? ms / 10000 : 0
      RunLoop.current.add(t, forMode: .default)
      self.timers[id] = t
    } as @convention(block) (Int, Double) -> Void)
    put("cancelTimer", { [unowned self] (id: Int) in self.timers.removeValue(forKey: id)?.invalidate() } as @convention(block) (Int) -> Void)
    put("watch", { [unowned self] (base: String) -> Int in self.watch(base) } as @convention(block) (String) -> Int)
    put("unwatch", { [unowned self] (id: Int) in
      if let s = self.watches.removeValue(forKey: id) {
        FSEventStreamStop(s)
        FSEventStreamInvalidate(s)
        FSEventStreamRelease(s)
      }
      self.watchBoxes[id] = nil
    } as @convention(block) (Int) -> Void)
    ctx.setObject(native, forKeyedSubscript: "native" as NSString)
    ctx.setObject(resources.path, forKeyedSubscript: "wasmDir" as NSString)
    let console = JSValue(newObjectIn: ctx)!
    for level in ["log", "warn", "error", "info", "debug"] {
      console.setObject({ (a: JSValue) in logLine("[codeboard js] %@", a.toString()) } as @convention(block) (JSValue) -> Void, forKeyedSubscript: level as NSString)
    }
    ctx.setObject(console, forKeyedSubscript: "console" as NSString)
  }
  /** The process is done: Storage's watchers (FSEvents), the timers and the JavaScript context go with it */
  deinit {
    let watches = self.watches, timers = self.timers
    js.post {
      for (_, s) in watches {
        FSEventStreamStop(s)
        FSEventStreamInvalidate(s)
        FSEventStreamRelease(s)
      }
      for (_, t) in timers { t.invalidate() }
    }
  }

  /** On the JavaScript thread: a reply goes to its call's callback (`typed` decodes there and hops to main), the rest to the main
   *  thread, in the order emitted */
  private func event(_ name: String, _ json: String) {
    if name == "reply" {
      struct Reply: Decodable {
        var req: Int
        var ok: Bool
        var json: String?
        var error: String?
      }
      guard let r = try? decodeJSON(Reply.self, json), let cb = pending.removeValue(forKey: r.req) else { return }
      cb(r.ok ? .success(r.json ?? "null") : .failure(JSError(message: r.error ?? "?")))
      return
    }
    struct Where: Decodable { var dir: String; var id: String? }
    let w = try? decodeJSON(Where.self, json)
    DispatchQueue.main.async { [self] in
      if let w, let f = folders[w.dir] { f.event(name, w.id, json) } else { onEvent?(name, json) }
    }
  }

  // FSEvents on the storage folder: changed files reach Storage through CodeBoard.fsChanged (posted to the JavaScript thread)
  private static let fsQueue = DispatchQueue(label: "codeboard.fsevents")
  private final class WatchBox {
    let id: Int
    weak var bridge: JSBridge?
    init(id: Int, bridge: JSBridge) { self.id = id; self.bridge = bridge }
  }
  private var watchBoxes: [Int: WatchBox] = [:]
  private func watch(_ base: String) -> Int {
    let id = nextWatch
    nextWatch += 1
    let box = WatchBox(id: id, bridge: self)
    watchBoxes[id] = box
    var cx = FSEventStreamContext()
    cx.info = Unmanaged.passUnretained(box).toOpaque()
    let cb: FSEventStreamCallback = { _, info, n, paths, flags, _ in
      guard let info else { return }
      let box = Unmanaged<WatchBox>.fromOpaque(info).takeUnretainedValue()
      let arr = unsafeBitCast(paths, to: NSArray.self)
      for i in 0..<n {
        guard let p = arr[i] as? String else { continue }
        if flags[i] & FSEventStreamEventFlags(kFSEventStreamEventFlagItemIsFile) == 0 { continue }
        box.bridge?.js.post { box.bridge?.api.invokeMethod("fsChanged", withArguments: [box.id, p]) }
      }
    }
    let flags = UInt32(kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer)
    // the stream reports the real path (/private/var…): give it that one so Storage's paths match
    let real = URL(fileURLWithPath: base).resolvingSymlinksInPath().path
    guard let s = FSEventStreamCreate(nil, cb, &cx, [real] as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.2, flags) else { return id }
    FSEventStreamSetDispatchQueue(s, JSBridge.fsQueue)
    FSEventStreamStart(s)
    watches[id] = s
    return id
  }

  /** A full garbage collection now (JavaScriptCore collects on its own schedule; the checks measure after one) */
  func collect() { js.post { [self] in JSGarbageCollect(ctx.jsGlobalContextRef) } }

  // Calls into CodeBoard: all asynchronous; the reply reaches `cb` on the JavaScript thread (`typed` and `onMain` bring it to the
  // main thread, in the order replies and events were emitted)
  /** The last JavaScript exception (the context's handler), on the JavaScript thread */
  private var lastError: String?
  private func call(_ name: String, _ args: [Any], _ cb: @escaping (Result<String, Error>) -> Void) {
    js.post { [self] in
      let req = nextReq
      nextReq += 1
      pending[req] = cb
      lastError = nil
      api.invokeMethod(name, withArguments: [req] + args)
      // thrown before the entry could settle the request (a board not open, bad arguments): the request fails now
      if let e = lastError, let cb = pending.removeValue(forKey: req) { cb(.failure(JSError(message: e))) }
    }
  }
  /** A call that answers with its return value */
  private func callValue<T: Decodable>(_ name: String, _ args: [Any], _ type: T.Type, _ cb: @escaping (T) -> Void) {
    js.post { [self] in
      let r = api.invokeMethod(name, withArguments: args)?.toString()
      let out = r.flatMap { try? decodeJSON(type, $0) }
      if let out { DispatchQueue.main.async { cb(out) } }
    }
  }
  /** Decoded on the JavaScript thread (a scene's JSON is big), delivered on the main thread */
  private func typed<T: Decodable>(_ type: T.Type, _ cb: @escaping (Result<T, Error>) -> Void) -> (Result<String, Error>) -> Void {
    { r in
      let out: Result<T, Error>
      switch r {
      case .failure(let e): out = .failure(e)
      case .success(let json):
        do { out = .success(try decodeJSON(type, json)) } catch { out = .failure(error) }
      }
      DispatchQueue.main.async { cb(out) }
    }
  }
  private func onMain(_ cb: @escaping (Result<String, Error>) -> Void) -> (Result<String, Error>) -> Void { { r in DispatchQueue.main.async { cb(r) } } }

  // MARK: folders and sessions
  /** A boards folder: its Storage, shared by every window on it (board windows, the library). `release` when a window is done */
  func folder(_ dir: String) -> Folder {
    if let f = folders[dir] { f.refs += 1; return f }
    let f = Folder(bridge: self, dir: dir)
    folders[dir] = f
    return f
  }
  private var folders: [String: Folder] = [:]
  func list(_ dir: String, _ cb: @escaping (Result<[BoardMeta], Error>) -> Void) { call("list", [dir], typed([BoardMeta].self, cb)) }
  /** The board's scene (its session is made on first open); the Session then drives it */
  func open(_ dir: String, _ id: String, _ cb: @escaping (Result<Scene, Error>) -> Void) { call("open", [dir, id], typed(Scene.self, cb)) }
  /** Unsaved changes written: a folder's, or every folder's */
  func flush(_ dir: String? = nil, _ cb: @escaping (Result<String, Error>) -> Void) { call("flush", dir.map { [$0] } ?? [], onMain(cb)) }
  fileprivate func closeFolder(_ dir: String, _ cb: @escaping (Result<String, Error>) -> Void) { call("closeFolder", [dir], onMain(cb)) }
  fileprivate func dropFolder(_ dir: String) { folders[dir] = nil }
  fileprivate func changes(_ dir: String, _ id: String, _ cb: @escaping (Result<SceneChange, Error>) -> Void) { call("changes", [dir, id], typed(SceneChange.self, cb)) }
  fileprivate func undo(_ dir: String, _ id: String, _ cb: @escaping (Result<SceneChange, Error>) -> Void) { call("undo", [dir, id], typed(SceneChange.self, cb)) }
  fileprivate func redo(_ dir: String, _ id: String, _ cb: @escaping (Result<SceneChange, Error>) -> Void) { call("redo", [dir, id], typed(SceneChange.self, cb)) }
  fileprivate func endDrag(_ dir: String, _ id: String, _ moves: [Move], _ cb: @escaping (Result<SceneChange, Error>) -> Void) { call("endDrag", [dir, id, encodeJSON(moves)], typed(SceneChange.self, cb)) }
  fileprivate func beginDrag(_ dir: String, _ id: String) { js.post { [self] in api.invokeMethod("beginDrag", withArguments: [dir, id]) } }
  /** A card as dragged: where it is and its size as drawn */
  struct Move: Encodable { var id: String; var x, y, w, h: Double }
  fileprivate func drag(_ dir: String, _ id: String, _ moves: [Move]) {
    let json = encodeJSON(moves)
    js.post { [self] in api.invokeMethod("drag", withArguments: [dir, id, json]) }
  }
  fileprivate func cam(_ dir: String, _ id: String, _ c: Camera) { js.post { [self] in api.invokeMethod("cam", withArguments: [dir, id, c.x, c.y, c.z]) } }
  fileprivate func route(_ dir: String, _ id: String, _ rects: [String: WorldRect], only: [String]?, modes: [String: String]?, _ cb: @escaping ([RouteGeo]) -> Void) {
    var args: [Any] = [dir, id, encodeJSON(rects), only.map(encodeJSON) ?? "null"]
    if let modes { args.append(encodeJSON(modes)) }
    callValue("route", args, [RouteGeo].self, cb)
  }
  fileprivate func benchEdit(_ dir: String, _ id: String, _ n: Int, _ cb: @escaping ([Double]) -> Void) { callValue("benchEdit", [dir, id, n], [Double].self, cb) }
  /** The library's calls (js/library.ts, CodeBoardLibrary): boards across storage folders, and the documents ⌘K indexes */
  /** A card's height in a resize: as it is, back to its content's, or this */
  enum Height {
    case keep, auto, fixed(Double)
    var arg: Any { switch self { case .keep: "keep"; case .auto: NSNull(); case .fixed(let h): h } }
  }
  fileprivate func resize(_ dir: String, _ id: String, _ card: String, w: Double, h: Height) { js.post { [self] in api.invokeMethod("resize", withArguments: [dir, id, card, w, h.arg]) } }
  // MARK: edits (js/commands.ts through entry.ts): each resolves with what changed; a new card's reply carries its id
  fileprivate func edit(_ name: String, _ dir: String, _ id: String, _ args: [Any], _ cb: @escaping (Result<SceneChange, Error>) -> Void) { call(name, [dir, id] + args, typed(SceneChange.self, cb)) }
  fileprivate func copy(_ dir: String, _ id: String, _ ids: [String], _ cb: @escaping (Int) -> Void) { callValue("copy", [dir, id, encodeJSON(ids)], Int.self, cb) }
  fileprivate func titles(_ dir: String, _ id: String, _ cb: @escaping ([[String: String]]) -> Void) { callValue("titles", [dir, id], [[String: String]].self, cb) }
  struct CardText: Decodable { var kind: String; var text: String; var lang: String?; var look: String? }
  /** nil when the card has no editable text (the reply is JSON null) */
  fileprivate func textOf(_ dir: String, _ id: String, _ card: String, _ cb: @escaping (CardText?) -> Void) {
    js.post { [self] in
      let r = api.invokeMethod("textOf", withArguments: [dir, id, card])?.toString()
      let out = r.flatMap { try? decodeJSON(CardText.self, $0) }
      DispatchQueue.main.async { cb(out) }
    }
  }
  func lib<T: Decodable>(_ name: String, _ args: [Any], _ type: T.Type, _ cb: @escaping (Result<T, Error>) -> Void) {
    js.post { [self] in
      let req = nextReq
      nextReq += 1
      pending[req] = typed(type, cb)
      ctx.objectForKeyedSubscript("CodeBoardLibrary").invokeMethod(name, withArguments: [req] + args)
    }
  }
  /** A library call that answers with its return value (a JSON string), on the main thread */
  func libString(_ name: String, _ cb: @escaping (String?) -> Void) {
    js.post { [self] in
      let r = ctx.objectForKeyedSubscript("CodeBoardLibrary").invokeMethod(name, withArguments: [])?.toString()
      DispatchQueue.main.async { cb(r) }
    }
  }
}

/** A boards folder as the windows see it: list and open its boards, its events (the folder's "boards", a board's "changed",
 *  "stacks", "toast"; "log"). Held by every window on the folder; the last `release` closes the Storage */
final class Folder {
  let dir: String
  private unowned let bridge: JSBridge
  fileprivate var refs = 1
  /** Events for the folder (name, board id or nil, json), to every listener; a window keeps the one for its board */
  private var listeners: [ObjectIdentifier: (String, String?, String) -> Void] = [:]
  fileprivate init(bridge: JSBridge, dir: String) {
    self.bridge = bridge
    self.dir = dir
  }
  func listen(_ owner: AnyObject, _ fn: @escaping (String, String?, String) -> Void) { listeners[ObjectIdentifier(owner)] = fn }
  func unlisten(_ owner: AnyObject) { listeners[ObjectIdentifier(owner)] = nil }
  fileprivate func event(_ name: String, _ id: String?, _ json: String) { for l in listeners.values { l(name, id, json) } }
  func list(_ cb: @escaping (Result<[BoardMeta], Error>) -> Void) { bridge.list(dir, cb) }
  /** The board's scene and the session that drives it */
  func open(_ id: String, _ cb: @escaping (Result<(Scene, Session), Error>) -> Void) {
    bridge.open(dir, id) { [self] r in cb(r.map { ($0, Session(bridge: bridge, dir: dir, id: id)) }) }
  }
  func flush(_ cb: @escaping () -> Void) { bridge.flush(dir) { _ in cb() } }
  /** A window on the folder closed: the last one closes the folder (flushed, nothing more watched or written) */
  func release() {
    refs -= 1
    guard refs == 0 else { return }
    bridge.dropFolder(dir)
    bridge.closeFolder(dir) { _ in }
  }
}

/** One open board inside the shared bridge: what a window does to it. Plain value; two windows on one board share the session */
struct Session {
  fileprivate let bridge: JSBridge
  let dir: String
  let id: String
  func changes(_ cb: @escaping (Result<SceneChange, Error>) -> Void) { bridge.changes(dir, id, cb) }
  func undo(_ cb: @escaping (Result<SceneChange, Error>) -> Void) { bridge.undo(dir, id, cb) }
  func redo(_ cb: @escaping (Result<SceneChange, Error>) -> Void) { bridge.redo(dir, id, cb) }
  func beginDrag() { bridge.beginDrag(dir, id) }
  func drag(_ moves: [JSBridge.Move]) { bridge.drag(dir, id, moves) }
  /** The drag ends with the cards at these rectangles: core puts them in the Section they land in */
  func endDrag(_ moves: [JSBridge.Move], _ cb: @escaping (Result<SceneChange, Error>) -> Void) { bridge.endDrag(dir, id, moves, cb) }
  func cam(_ c: Camera) { bridge.cam(dir, id, c) }
  /** The arrows' geometry for these card rectangles (all links, or only the ones named), on the main thread when routed; modes =
   *  the side choices the drag's live routes (RouteWorker) made, adopted so the final route does not jump */
  func route(_ rects: [String: WorldRect], only: [String]? = nil, modes: [String: String]? = nil, _ cb: @escaping ([RouteGeo]) -> Void) { bridge.route(dir, id, rects, only: only, modes: modes, cb) }
  /** The M1 gate: n single-card edits through core's history; each one's time in ms */
  func benchEdit(_ n: Int, _ cb: @escaping ([Double]) -> Void) { bridge.benchEdit(dir, id, n, cb) }
  /** A live resize inside a drag gesture (beginDrag … endDrag) */
  func resize(_ card: String, w: Double, h: JSBridge.Height) { bridge.resize(dir, id, card, w: w, h: h) }
  // MARK: edits (js/commands.ts): each resolves with what changed; a new card's reply carries its id
  func newWriting(_ look: String, x: Double, y: Double, _ cb: @escaping (Result<SceneChange, Error>) -> Void) { bridge.edit("newWriting", dir, id, [look, x, y], cb) }
  func newCode(x: Double, y: Double, _ cb: @escaping (Result<SceneChange, Error>) -> Void) { bridge.edit("newCode", dir, id, [x, y], cb) }
  func writeNote(_ card: String, md: String, _ cb: @escaping (Result<SceneChange, Error>) -> Void) { bridge.edit("writeNote", dir, id, [card, md], cb) }
  func writeCode(_ card: String, text: String, _ cb: @escaping (Result<SceneChange, Error>) -> Void) { bridge.edit("writeCode", dir, id, [card, text], cb) }
  func settleUnwritten(_ card: String, _ cb: @escaping (Result<SceneChange, Error>) -> Void) { bridge.edit("settleUnwritten", dir, id, [card], cb) }
  func deleteItems(cards: [String], links: [String], sections: [String], _ cb: @escaping (Result<SceneChange, Error>) -> Void) {
    bridge.edit("deleteItems", dir, id, [encodeJSON(cards), encodeJSON(links), encodeJSON(sections)], cb)
  }
  func duplicate(_ ids: [String], _ cb: @escaping (Result<SceneChange, Error>) -> Void) { bridge.edit("duplicate", dir, id, [encodeJSON(ids)], cb) }
  /** How many cards were copied (on the main thread) */
  func copy(_ ids: [String], _ cb: @escaping (Int) -> Void) { bridge.copy(dir, id, ids, cb) }
  func paste(_ cb: @escaping (Result<SceneChange, Error>) -> Void) { bridge.edit("paste", dir, id, [], cb) }
  func addLink(from: String, to: String, _ cb: @escaping (Result<SceneChange, Error>) -> Void) { bridge.edit("addLink", dir, id, [from, to], cb) }
  func newSection(_ ids: [String], rects: [String: WorldRect], _ cb: @escaping (Result<SceneChange, Error>) -> Void) {
    bridge.edit("newSection", dir, id, [encodeJSON(ids), encodeJSON(rects)], cb)
  }
  func renameSection(_ section: String, title: String, _ cb: @escaping (Result<SceneChange, Error>) -> Void) { bridge.edit("renameSection", dir, id, [section, title], cb) }
  /** An image (a data: URL) saved to assets/ as an Image card `w` wide at (x, y); the reply carries its id */
  func newImage(_ name: String, dataUrl: String, w: Double, x: Double, y: Double, _ cb: @escaping (Result<SceneChange, Error>) -> Void) {
    bridge.edit("newImage", dir, id, [name, dataUrl, w, x, y], cb)
  }
  /** The cards become a new board named `name`, a sub-board card in their place (its id in the reply) */
  func turnIntoBoard(_ ids: [String], name: String, rects: [String: WorldRect], _ cb: @escaping (Result<SceneChange, Error>) -> Void) {
    bridge.edit("turnIntoBoard", dir, id, [encodeJSON(ids), name, encodeJSON(rects)], cb)
  }
  /** A new empty board as a sub-board card at (x, y) */
  func newSubboard(_ name: String, x: Double, y: Double, _ cb: @escaping (Result<SceneChange, Error>) -> Void) { bridge.edit("newSubboard", dir, id, [name, x, y], cb) }
  /** A Section folded to its title bar (open = its frame as drawn, kept for unfolding) or opened again */
  func foldSection(_ section: String, shut: Bool, open: WorldRect, _ cb: @escaping (Result<SceneChange, Error>) -> Void) {
    bridge.edit("foldSection", dir, id, [section, shut, encodeJSON(open)], cb)
  }
  func addSticker(pack: String, name: String, x: Double, y: Double, _ cb: @escaping (Result<SceneChange, Error>) -> Void) { bridge.edit("addSticker", dir, id, [pack, name, x, y], cb) }
  func deleteStickers(_ ids: [String], _ cb: @escaping (Result<SceneChange, Error>) -> Void) { bridge.edit("deleteStickers", dir, id, [encodeJSON(ids)], cb) }
  /** A Text sidenote on a whole card; the reply carries its id */
  func addSidenote(_ card: String, md: String, _ cb: @escaping (Result<SceneChange, Error>) -> Void) { bridge.edit("addSidenote", dir, id, [card, md], cb) }
  func writeSidenote(_ sn: String, md: String, _ cb: @escaping (Result<SceneChange, Error>) -> Void) { bridge.edit("writeSidenote", dir, id, [sn, md], cb) }
  func deleteSidenote(_ sn: String, _ cb: @escaping (Result<SceneChange, Error>) -> Void) { bridge.edit("deleteSidenote", dir, id, [sn], cb) }
  /** The board's card titles, for [[refs]] */
  func titles(_ cb: @escaping ([[String: String]]) -> Void) { bridge.titles(dir, id, cb) }
  /** The editable text of a Note / Text / Free code card, or nil */
  func textOf(_ card: String, _ cb: @escaping (JSBridge.CardText?) -> Void) { bridge.textOf(dir, id, card, cb) }
}
