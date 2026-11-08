// The JavaScript side (dist/bridge.js: @codeboard/core and the host's Storage, see js/bridge.ts) in JavaScriptCore. This is the
// shell's `native` (js/native.ts: a synchronous file system, timers on the main queue, FSEvents for the storage folder) and the
// typed calls into `CodeBoard`. Everything runs on the main thread; async results come back through the "reply" event.
import AppKit
import CoreServices
import CryptoKit
import JavaScriptCore

final class JSBridge {
  private let ctx: JSContext
  private var api: JSValue { ctx.objectForKeyedSubscript("CodeBoard") }
  private var pending: [Int: (Result<String, Error>) -> Void] = [:]
  private var nextReq = 1
  private var timers: [Int: Timer] = [:]
  private var watches: [Int: FSEventStreamRef] = [:]
  private var nextWatch = 1
  /** Events for the shell: changed (SceneChange), boards (BoardMeta[]), toast (string), stacks ({undo, redo}), log */
  var onEvent: ((String, String) -> Void)?
  struct JSError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
  }

  init(bundle: URL, resources: URL) throws {
    ctx = JSContext()!
    ctx.exceptionHandler = { _, e in logLine("[codeboard js] %@", e?.toString() ?? "?") }
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
    put("now", { () -> Double in CACurrentMediaTime() * 1000 } as @convention(block) () -> Double)
    put("emit", { [unowned self] (name: String, json: String) in self.event(name, json) } as @convention(block) (String, String) -> Void)
    // run-loop timers, not dispatch blocks: they fire in nested run loops too (a sheet, the quit confirmation waiting on a flush)
    put("setTimer", { [unowned self] (id: Int, ms: Double) in
      self.timers[id]?.invalidate()
      let t = Timer(timeInterval: ms / 1000, repeats: false) { [weak self] _ in
        guard let self else { return }
        self.timers[id] = nil
        self.api.invokeMethod("timer", withArguments: [id])
      }
      t.tolerance = ms > 100 ? ms / 10000 : 0
      RunLoop.main.add(t, forMode: .common)
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
    let src = try String(contentsOf: bundle, encoding: .utf8)
    ctx.evaluateScript(src, withSourceURL: bundle)
    if api.isUndefined { throw JSError(message: "bridge.js did not define CodeBoard") }
  }
  /** The window is gone: Storage's watchers (FSEvents), the timers and the JavaScript context go with it */
  deinit {
    for (_, s) in watches {
      FSEventStreamStop(s)
      FSEventStreamInvalidate(s)
      FSEventStreamRelease(s)
    }
    for (_, t) in timers { t.invalidate() }
  }

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
    onEvent?(name, json)
  }

  // FSEvents on the storage folder: changed files reach Storage through CodeBoard.fsChanged
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
        box.bridge?.api.invokeMethod("fsChanged", withArguments: [box.id, p])
      }
    }
    let flags = UInt32(kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer)
    // the stream reports the real path (/private/var…): give it that one so Storage's paths match
    let real = URL(fileURLWithPath: base).resolvingSymlinksInPath().path
    guard let s = FSEventStreamCreate(nil, cb, &cx, [real] as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.2, flags) else { return id }
    FSEventStreamSetDispatchQueue(s, .main)
    FSEventStreamStart(s)
    watches[id] = s
    return id
  }

  // Calls into CodeBoard
  private func call(_ name: String, _ args: [Any], _ cb: @escaping (Result<String, Error>) -> Void) {
    let req = nextReq
    nextReq += 1
    pending[req] = cb
    api.invokeMethod(name, withArguments: [req] + args)
  }
  private func typed<T: Decodable>(_ type: T.Type, _ cb: @escaping (Result<T, Error>) -> Void) -> (Result<String, Error>) -> Void {
    { r in
      switch r {
      case .failure(let e): cb(.failure(e))
      case .success(let json):
        do { cb(.success(try decodeJSON(type, json))) } catch { cb(.failure(error)) }
      }
    }
  }

  func initStorage(dir: String) { api.invokeMethod("init", withArguments: [dir]) }
  /** Before the window lets go of the bridge: Storage stops watching and writing */
  func dispose() { api.invokeMethod("dispose", withArguments: []) }
  func list(_ cb: @escaping (Result<[BoardMeta], Error>) -> Void) { call("list", [], typed([BoardMeta].self, cb)) }
  func open(_ id: String, _ cb: @escaping (Result<Scene, Error>) -> Void) { call("open", [id], typed(Scene.self, cb)) }
  func changes(_ cb: @escaping (Result<SceneChange, Error>) -> Void) { call("changes", [], typed(SceneChange.self, cb)) }
  func undo(_ cb: @escaping (Result<SceneChange, Error>) -> Void) { call("undo", [], typed(SceneChange.self, cb)) }
  func redo(_ cb: @escaping (Result<SceneChange, Error>) -> Void) { call("redo", [], typed(SceneChange.self, cb)) }
  /** The drag ends with the cards at these rectangles: core puts them in the Section they land in */
  func endDrag(_ moves: [Move], _ cb: @escaping (Result<SceneChange, Error>) -> Void) { call("endDrag", [encodeJSON(moves)], typed(SceneChange.self, cb)) }
  func flush(_ cb: @escaping (Result<String, Error>) -> Void) { call("flush", [], cb) }
  func beginDrag() { api.invokeMethod("beginDrag", withArguments: []) }
  /** A card as dragged: where it is and its size as drawn */
  struct Move: Encodable { var id: String; var x, y, w, h: Double }
  func drag(_ moves: [Move]) { api.invokeMethod("drag", withArguments: [encodeJSON(moves)]) }
  func cam(_ c: Camera) { api.invokeMethod("cam", withArguments: [c.x, c.y, c.z]) }
  /** Synchronous: the arrows' geometry for these card rectangles (all links, or only the ones named) */
  func route(_ rects: [String: WorldRect], only: [String]? = nil) -> [RouteGeo] {
    var args: [Any] = [encodeJSON(rects)]
    if let only { args.append(encodeJSON(only)) }
    guard let r = api.invokeMethod("route", withArguments: args)?.toString() else { return [] }
    return (try? decodeJSON([RouteGeo].self, r)) ?? []
  }
  /** The M1 gate: n single-card edits through core's history; each one's time in ms */
  func benchEdit(_ n: Int) -> [Double] {
    guard let r = api.invokeMethod("benchEdit", withArguments: [n])?.toString() else { return [] }
    return (try? decodeJSON([Double].self, r)) ?? []
  }
}
