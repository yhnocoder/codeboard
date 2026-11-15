import CodeBoardModel
import Foundation
import Security
import Synchronization

// The AI summary writer over an OpenAI-compatible chat endpoint (host deepseek.ts deepseekPost and summaries.ts
// summarize), where its key is kept, and the AI settings in the app's defaults. The key is never logged nor written to
// the defaults.

/// The key in the Keychain, as a generic password under the app's own bundle identifier, so a bare binary (swift run,
/// tests) never reads the installed app's item
struct KeychainKeyStore: KeyStore {
  struct Failure: Error { let status: OSStatus }
  let service: String
  static let account = "deepseekApiKey"

  init(service: String = Bundle.main.bundleIdentifier ?? "CodeBoard") { self.service = service }

  private var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: Self.account,
    ]
  }

  func key() -> String? {
    var q = query
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  func setKey(_ key: String?) throws {
    let deleted = SecItemDelete(query as CFDictionary)
    guard deleted == errSecSuccess || deleted == errSecItemNotFound else { throw Failure(status: deleted) }
    guard let key = key?.trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty else { return }
    var q = query
    q[kSecValueData as String] = Data(key.utf8)
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    let added = SecItemAdd(q as CFDictionary, nil)
    guard added == errSecSuccess else { throw Failure(status: added) }
  }
}

/// The key in memory, for tests and previews
final class MemoryKeyStore: KeyStore {
  private let stored: Mutex<String?>
  init(_ key: String? = nil) { stored = Mutex(key) }
  func key() -> String? { stored.withLock { $0 } }
  func setKey(_ key: String?) {
    let t = key?.trimmingCharacters(in: .whitespacesAndNewlines)
    stored.withLock { $0 = t?.isEmpty == false ? t : nil }
  }
}

/// One POST to `<base>/chat/completions` per summary, with the request and answers of the host's summarize: no retries,
/// no streaming
struct OpenAISummaryWriter: SummaryWriter {
  static let defaultBase = "https://api.deepseek.com"
  static let defaultModel = "deepseek-flash"
  /// Empty: DeepSeek's
  var baseURL = ""
  /// Empty: deepseek-flash
  var model = ""
  var keys: any KeyStore
  var session = URLSession.shared
  /// For the whole exchange (SUMMARY_TIMEOUT)
  var timeout = Duration.seconds(60)

  var endpoint: URL? {
    var base = baseURL.isEmpty ? Self.defaultBase : baseURL
    while base.hasSuffix("/") { base.removeLast() }
    return URL(string: base + "/chat/completions")
  }

  private struct TimedOut: Error {}

  func write(system: String, user: String) async throws(SummaryFailure) -> String {
    guard let key = keys.key()?.trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty else { throw .noKey }
    guard let url = endpoint else { throw .network("Not a valid address: \(baseURL)") }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
    let body: [String: Any] = [
      "model": model.isEmpty ? Self.defaultModel : model,
      "max_tokens": 800,
      "temperature": 0.2,
      "stream": false,
      // deepseek-flash otherwise thinks first and spends max_tokens on it; other servers ignore it
      "thinking": ["type": "disabled"],
      "messages": [["role": "system", "content": system], ["role": "user", "content": user]],
    ]
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await exchange(req)
    } catch let e as URLError where e.code == .timedOut {
      throw .timeout
    } catch is TimedOut {
      throw .timeout
    } catch {
      throw .network(error.localizedDescription)
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    let message = (json?["error"] as? [String: Any])?["message"] as? String
    switch status {
    case 401: throw .badKey(message)
    case 402: throw .balance(message)
    case 200..<300:
      let first = (json?["choices"] as? [[String: Any]])?.first
      return (first?["message"] as? [String: Any])?["content"] as? String ?? ""
    default: throw .http(message ?? "HTTP \(status)")
    }
  }

  /// The request raced against the timeout; the loser is cancelled
  private func exchange(_ req: URLRequest) async throws -> (Data, URLResponse) {
    let (session, timeout) = (session, timeout)
    return try await withThrowingTaskGroup(of: (Data, URLResponse).self) { g in
      g.addTask { try await session.data(for: req) }
      g.addTask {
        try await Task.sleep(for: timeout)
        throw TimedOut()
      }
      defer { g.cancelAll() }
      return try await g.next()!
    }
  }
}

/// The AI settings in the defaults (the app: .standard). The key is not one of them: it is only in the KeyStore.
struct AISettings {
  static let switchKey = "summarySwitch"
  static let baseURLKey = "ai.baseURL"
  static let modelKey = "ai.model"
  let defaults: UserDefaults

  var summarySwitch: SummarySwitch {
    get { defaults.string(forKey: Self.switchKey).flatMap(SummarySwitch.init) ?? .default }
    nonmutating set { defaults.set(newValue.rawValue, forKey: Self.switchKey) }
  }
  /// Empty: DeepSeek's
  var baseURL: String {
    get { defaults.string(forKey: Self.baseURLKey) ?? "" }
    nonmutating set { defaults.set(newValue, forKey: Self.baseURLKey) }
  }
  /// Empty: deepseek-flash
  var model: String {
    get { defaults.string(forKey: Self.modelKey) ?? "" }
    nonmutating set { defaults.set(newValue, forKey: Self.modelKey) }
  }

  /// The writer these settings and `keys` describe
  func writer(keys: any KeyStore, session: URLSession = .shared) -> OpenAISummaryWriter {
    OpenAISummaryWriter(baseURL: baseURL, model: model, keys: keys, session: session)
  }
}
