// Where the app reads and keeps the user's things. CODEBOARD_HOME=<dir> (the human-use gate, tools/mac-gate.mjs --human) puts all
// of it in a sandbox: <dir> stands for the home folder (VS Code's registry and settings under Library/Application Support/Code,
// ~/.codeboard/stickers), the caches (which CODEBOARD_CACHES moves too when there is no sandbox) and Application Support under <dir>/Library, the defaults in <dir>/Preferences/CodeBoard.plist
// (CFPreferences takes an absolute path as a domain, but one ending in Library/Preferences/<name> inside the home folder is the
// user's own domain <name>: every sandbox shared ~/Library/Preferences/CodeBoard.plist). Box follows BOX_HOME, which the gate sets beside it.
import Foundation

enum Home {
  static let sandbox = ProcessInfo.processInfo.environment["CODEBOARD_HOME"].flatMap { $0.isEmpty ? nil : $0 }
  static let dir = sandbox.map { URL(fileURLWithPath: $0, isDirectory: true) } ?? FileManager.default.homeDirectoryForCurrentUser
  /** CODEBOARD_HOME's Library/Caches when sandboxed; else $CODEBOARD_CACHES (the gate's per-run temporary caches); else the user's */
  static let caches = sandbox != nil ? dir.appendingPathComponent("Library/Caches")
    : ProcessInfo.processInfo.environment["CODEBOARD_CACHES"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true) }
    ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
  static let support = sandbox == nil ? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0] : dir.appendingPathComponent("Library/Application Support")
  static let defaults: UserDefaults = sandbox.flatMap { UserDefaults(suiteName: "\($0)/Preferences/CodeBoard") } ?? .standard
}
