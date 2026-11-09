// Where the app reads and keeps the user's things. CODEBOARD_HOME=<dir> (the human-use gate, tools/mac-gate.mjs --human) puts all
// of it in a sandbox: <dir> stands for the home folder (VS Code's registry and settings under Library/Application Support/Code,
// ~/.codeboard/stickers), the caches and Application Support under <dir>/Library, the defaults in <dir>/Library/Preferences/
// CodeBoard.plist (CFPreferences takes an absolute path as a domain). Box follows BOX_HOME, which the gate sets beside it.
import Foundation

enum Home {
  static let sandbox = ProcessInfo.processInfo.environment["CODEBOARD_HOME"].flatMap { $0.isEmpty ? nil : $0 }
  static let dir = sandbox.map { URL(fileURLWithPath: $0, isDirectory: true) } ?? FileManager.default.homeDirectoryForCurrentUser
  static let caches = sandbox == nil ? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0] : dir.appendingPathComponent("Library/Caches")
  static let support = sandbox == nil ? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0] : dir.appendingPathComponent("Library/Application Support")
  static let defaults: UserDefaults = sandbox.flatMap { UserDefaults(suiteName: "\($0)/Library/Preferences/CodeBoard") } ?? .standard
}
