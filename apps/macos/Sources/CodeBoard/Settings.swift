// The app's settings: the same names and defaults as the extension's (packages/core/src/settings.ts, codeboard.*), kept in the
// app's defaults; a setting not set here starts from VS Code's user settings. The embedding server's key is kept
// with them (the extension keeps it in VS Code's secret storage). The Settings window: theme, embeddings, library folders.
import AppKit
import SwiftUI

extension Notification.Name {
  /** A setting changed (the theme, the embedding server): who shows or uses it follows */
  static let codeboardSettings = Notification.Name("CodeBoard.settings")
}

enum AppSettings {
  /** core's defaults for every codeboard.* setting (settingsSchema, from the bundle: AppDelegate loads them) */
  private static var defaults: [String: Any] = [:]
  static func load(defaults json: String?) {
    defaults = json.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] } ?? [:]
  }
  private static let vscode: [String: Any] = {
    guard let d = try? Data(contentsOf: Projects.vscodeUser.appendingPathComponent("settings.json")),
      let o = try? JSONSerialization.jsonObject(with: d, options: [.json5Allowed]) as? [String: Any]
    else { return [:] }
    return o
  }()
  static func value(_ key: String) -> Any? {
    Home.defaults.object(forKey: "codeboard.\(key)") ?? vscode["codeboard.\(key)"] ?? defaults["codeboard.\(key)"]
  }
  static func string(_ key: String) -> String { ((value(key) as? String) ?? "").trimmingCharacters(in: .whitespaces) }
  static func bool(_ key: String) -> Bool { value(key) as? Bool ?? false }
  private static var posts: [String: Timer] = [:]
  /** Kept at once; who follows the setting hears of it once typing in its field pauses */
  static func set(_ key: String, _ v: Any) {
    Home.defaults.set(v, forKey: "codeboard.\(key)")
    posts[key]?.invalidate()
    let t = Timer(timeInterval: 0.6, repeats: false) { _ in NotificationCenter.default.post(name: .codeboardSettings, object: key) }
    RunLoop.main.add(t, forMode: .common)
    posts[key] = t
  }

  // MARK: the embedding server's key: kept with the other settings (a key for a server on this Mac; the Keychain would ask
  // the user again after every build of an ad-hoc signed app)
  static var embeddingKey: String? {
    let k = string("search.embeddingKey")
    return k.isEmpty ? nil : k
  }
  static func setEmbeddingKey(_ key: String) { set("search.embeddingKey", key) }
}

final class SettingsModel: ObservableObject {
  @Published var url = AppSettings.string("search.embeddingUrl") { didSet { AppSettings.set("search.embeddingUrl", url) } }
  @Published var model = AppSettings.string("search.embeddingModel") { didSet { AppSettings.set("search.embeddingModel", model) } }
  @Published var rerank = AppSettings.bool("search.rerank") { didSet { AppSettings.set("search.rerank", rerank) } }
  @Published var rerankModel = AppSettings.string("search.rerankModel") { didSet { AppSettings.set("search.rerankModel", rerankModel) } }
  /** Where a board window's tools are: floating at the bottom (the default, as on the VS Code board) or in the title row */
  @Published var toolbar = AppSettings.string("mac.toolbar") == "top" ? "top" : "bottom" { didSet { AppSettings.set("mac.toolbar", toolbar) } }
  @Published var key = ""
  @Published var folders = Projects.added
  @Published var status = ""
  func saveKey() {
    AppSettings.setEmbeddingKey(key.trimmingCharacters(in: .whitespaces))
    key = ""
  }
  func setFolders(_ f: [String]) {
    folders = f
    Projects.added = f
    NotificationCenter.default.post(name: .codeboardSettings, object: "libraryFolders")
  }
}

struct SettingsView: View {
  @ObservedObject var m: SettingsModel
  @ObservedObject var search: SearchIndex
  @ObservedObject private var look = Look.shared
  var body: some View {
    let ch = look.chrome
    TabView {
      Form {
        Picker("Look", selection: Binding(get: { look.chrome.id }, set: { look.set($0) })) {
          ForEach(Chrome.all, id: \.id) { Text($0.name).tag($0.id) }
        }
        Text("The board's theme and the windows around it. Light and dark follow the system.").font(.callout).foregroundStyle(.secondary)
        Picker("Toolbar", selection: $m.toolbar) {
          Text("Bottom").tag("bottom")
          Text("Top").tag("top")
        }
        .pickerStyle(.segmented)
      }
      .formStyle(.grouped)
      .tabItem { Label("Board", systemImage: "square.on.square") }
      Form {
        Section {
          TextField("Server", text: $m.url, prompt: Text("http://127.0.0.1:11001/v1"))
          TextField("Model", text: $m.model, prompt: Text("first with “embed” in its name"))
          HStack {
            SecureField("API key", text: $m.key, prompt: Text(AppSettings.embeddingKey == nil ? "none set" : "saved"))
            Button("Save") { m.saveKey() }.disabled(m.key.isEmpty)
          }
        } header: {
          Text("Search by meaning")
        } footer: {
          HStack(spacing: 6) {
            Circle().fill(search.semantic ? Color.green : Color.secondary.opacity(0.5)).frame(width: 7, height: 7)
            Text(search.status)
          }
          .font(.callout).foregroundStyle(.secondary)
        }
        Section {
          Toggle("Rerank the best results", isOn: $m.rerank)
          TextField("Reranking model", text: $m.rerankModel, prompt: Text("first with “rerank” in its name"))
        }
      }
      .formStyle(.grouped)
      .tabItem { Label("Search", systemImage: "magnifyingglass") }
      Form {
        Section {
          ForEach(m.folders, id: \.self) { f in
            HStack {
              Label((f as NSString).abbreviatingWithTildeInPath, systemImage: "folder")
              Spacer()
              Button(role: .destructive) { m.setFolders(m.folders.filter { $0 != f }) } label: { Image(systemName: "minus.circle") }
                .buttonStyle(.borderless)
            }
          }
          Button("Add Folder…") {
            let p = NSOpenPanel()
            p.canChooseDirectories = true
            p.canChooseFiles = false
            p.allowsMultipleSelection = true
            if p.runModal() == .OK { m.setFolders(m.folders + p.urls.map(\.path).filter { !m.folders.contains($0) }) }
          }
        } header: {
          Text("Library folders")
        } footer: {
          Text("Besides these, the library shows every project VS Code's CodeBoard knows.").font(.callout).foregroundStyle(.secondary)
        }
      }
      .formStyle(.grouped)
      .tabItem { Label("Library", systemImage: "books.vertical") }
    }
    .scrollContentBackground(.hidden)
    .background(ch.content.color)
    .tint(ch.accent.color)
    .frame(width: 520, height: 400)
  }
}

final class SettingsWindowController: NSWindowController {
  convenience init(model: SettingsModel, search: SearchIndex) {
    let w = NSWindow(contentViewController: NSHostingController(rootView: SettingsView(m: model, search: search)))
    w.title = "Settings"
    w.styleMask = [.titled, .closable]
    w.setFrameAutosaveName("CodeBoard.settings")
    self.init(window: w)
  }
}
