import AppKit
import CodeBoardNotes
import Foundation
import Testing

@testable import CodeBoardModel
@testable import CodeBoardShell

// The AI summary writer without the network (a URL protocol answers from memory and records what was sent), the key
// in memory, the settings in a defaults suite of their own, and the Settings window off screen

/// Answers every request with `SummaryStub.answer`, and keeps the last request and its body
final class SummaryStub: URLProtocol, @unchecked Sendable {
  enum Answer {
    case reply(status: Int, body: String)
    case fail(URLError)
    /// Never answers
    case hang
  }
  nonisolated(unsafe) static var answer = Answer.reply(status: 200, body: "{}")
  nonisolated(unsafe) static var last: URLRequest?
  nonisolated(unsafe) static var lastBody: Data?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    SummaryStub.last = request
    // inside a URL protocol the body arrives as a stream
    if let stream = request.httpBodyStream {
      stream.open()
      var data = Data()
      var buf = [UInt8](repeating: 0, count: 4096)
      while case let n = stream.read(&buf, maxLength: buf.count), n > 0 { data.append(buf, count: n) }
      stream.close()
      SummaryStub.lastBody = data
    } else {
      SummaryStub.lastBody = request.httpBody
    }
    switch SummaryStub.answer {
    case .reply(let status, let body):
      let resp = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
      client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(body.utf8))
      client?.urlProtocolDidFinishLoading(self)
    case .fail(let e): client?.urlProtocol(self, didFailWithError: e)
    case .hang: break
    }
  }

  override func stopLoading() {}

  static func reset(_ a: Answer) {
    answer = a
    last = nil
    lastBody = nil
  }

  static var session: URLSession {
    let c = URLSessionConfiguration.ephemeral
    c.protocolClasses = [SummaryStub.self]
    return URLSession(configuration: c)
  }
}

private func writer(base: String = "", model: String = "", key: String? = "sk-test") -> OpenAISummaryWriter {
  OpenAISummaryWriter(baseURL: base, model: model, keys: MemoryKeyStore(key), session: SummaryStub.session)
}

private func failure(_ w: OpenAISummaryWriter) async -> SummaryFailure? {
  do {
    _ = try await w.write(system: "s", user: "u")
    return nil
  } catch {
    return error
  }
}

/// A defaults suite of the test's own, removed after
private func withDefaults(_ body: (UserDefaults, String) throws -> Void) rethrows {
  let name = "codeboard-tests-\(UUID().uuidString)"
  let d = UserDefaults(suiteName: name)!
  defer { d.removePersistentDomain(forName: name) }
  try body(d, name)
}

@Suite(.serialized) struct SummaryWriterTests {
  @Test func theRequestIsDeepSeeksChatCompletionWithTheKey() async throws {
    SummaryStub.reset(.reply(status: 200, body: #"{"choices":[{"message":{"content":"一句话"}}]}"#))
    let text = try await writer().write(system: "SYS", user: "USER")
    #expect(text == "一句话")
    let r = try #require(SummaryStub.last)
    #expect(r.url?.absoluteString == "https://api.deepseek.com/chat/completions")
    #expect(r.httpMethod == "POST")
    #expect(r.value(forHTTPHeaderField: "Content-Type") == "application/json")
    #expect(r.value(forHTTPHeaderField: "Accept") == "application/json")
    #expect(r.value(forHTTPHeaderField: "Authorization") == "Bearer sk-test")
    let sent = try #require(SummaryStub.lastBody)
    let body = try #require(try JSONSerialization.jsonObject(with: sent) as? [String: Any])
    #expect(body["model"] as? String == "deepseek-flash")
    #expect(body["max_tokens"] as? Int == 800)
    #expect(body["temperature"] as? Double == 0.2)
    #expect(body["stream"] as? Bool == false)
    #expect((body["thinking"] as? [String: String]) == ["type": "disabled"])
    #expect(
      (body["messages"] as? [[String: String]])
        == [["role": "system", "content": "SYS"], ["role": "user", "content": "USER"]])
    #expect(body["response_format"] == nil)
  }

  @Test func theBaseAndModelSettingsAreUsed() async throws {
    SummaryStub.reset(.reply(status: 200, body: #"{"choices":[{"message":{}}]}"#))
    // no content: empty text (summarize turns it into "DeepSeek returned an empty answer")
    #expect(try await writer(base: "http://x//", model: "m1").write(system: "s", user: "u") == "")
    #expect(SummaryStub.last?.url?.absoluteString == "http://x/chat/completions")
    let body = try JSONSerialization.jsonObject(with: #require(SummaryStub.lastBody)) as? [String: Any]
    #expect(body?["model"] as? String == "m1")
  }

  @Test func statusesMapToFailures() async {
    let cases: [(Int, String, SummaryFailure)] = [
      (401, #"{"error":{"message":"bad key"}}"#, .badKey("bad key")),
      (402, #"{"error":{"message":"no money"}}"#, .balance("no money")),
      (402, "", .balance(nil)),
      (500, #"{"error":{"message":"boom"}}"#, .http("boom")),
      (503, "Service Unavailable", .http("HTTP 503")),
    ]
    for (status, body, expected) in cases {
      SummaryStub.reset(.reply(status: status, body: body))
      #expect(await failure(writer()) == expected, "HTTP \(status)")
    }
  }

  @Test func noKeySendsNothing() async {
    SummaryStub.reset(.reply(status: 200, body: "{}"))
    #expect(await failure(writer(key: nil)) == .noKey)
    #expect(await failure(writer(key: "  ")) == .noKey)
    #expect(SummaryStub.last == nil)
  }

  @Test func networkErrorsAndTimeouts() async {
    SummaryStub.reset(.fail(URLError(.cannotFindHost)))
    guard case .network = await failure(writer()) else {
      Issue.record("not .network")
      return
    }
    SummaryStub.reset(.fail(URLError(.timedOut)))
    #expect(await failure(writer()) == .timeout)
    // the whole exchange is timed: a server that never answers
    SummaryStub.reset(.hang)
    var w = writer()
    w.timeout = .milliseconds(100)
    #expect(await failure(w) == .timeout)
  }

  @Test func theMemoryStoreKeepsATrimmedKeyAndBlankRemovesIt() {
    let s = MemoryKeyStore()
    #expect(s.key() == nil)
    s.setKey("  sk-1 \n")
    #expect(s.key() == "sk-1")
    s.setKey(" ")
    #expect(s.key() == nil)
    s.setKey("sk-2")
    s.setKey(nil)
    #expect(s.key() == nil)
  }

  @Test func settingsHaveDefaultsAndRoundTrip() {
    withDefaults { d, _ in
      let s = AISettings(defaults: d)
      #expect(s.summarySwitch == .inPlace && s.baseURL == "" && s.model == "")
      let w = s.writer(keys: MemoryKeyStore())
      #expect(w.endpoint?.absoluteString == "https://api.deepseek.com/chat/completions")
      s.summarySwitch = .continuous
      s.baseURL = "http://local:8080/v1/"
      s.model = "qwen"
      let again = AISettings(defaults: d)
      #expect(again.summarySwitch == .continuous && again.baseURL == "http://local:8080/v1/" && again.model == "qwen")
      #expect(again.writer(keys: MemoryKeyStore()).endpoint?.absoluteString == "http://local:8080/v1/chat/completions")
    }
  }

  @MainActor @Test func theSettingsWindowStoresTheSwitchAndTheKey() throws {
    _ = NSApplication.shared
    try withDefaults { d, name in
      let keys = MemoryKeyStore()
      let w = SettingsWindow(
        settings: AISettings(defaults: d), keys: keys, search: SearchSettings(defaults: d), searchKeys: MemoryKeyStore()
      )
      w.window.setFrameOrigin(CGPoint(x: -30000, y: -30000))
      w.window.level = .underDesktop
      w.window.orderFrontRegardless()
      defer { w.window.close() }
      var switched: [SummarySwitch] = []
      var hasKey: [Bool] = []
      w.onSwitchChange = { switched.append($0) }
      w.onKeyChange = { hasKey.append($0) }
      #expect(w.switchControl.selectedSegment == 0)
      #expect(w.keyField.stringValue == "" && w.keyStatus.stringValue == "")
      // no key: no line under it, and no gap where it would be
      @MainActor func statusRowShown() -> Bool { w.grid.cell(for: w.keyStatus)?.row?.isHidden == false }
      #expect(!statusRowShown())

      w.switchControl.selectedSegment = 1
      w.switchControl.sendAction(w.switchControl.action, to: w.switchControl.target)
      #expect(switched == [.continuous])
      #expect(AISettings(defaults: d).summarySwitch == .continuous)

      w.keyField.stringValue = " sk-secret "
      w.keyField.sendAction(w.keyField.action, to: w.keyField.target)
      #expect(keys.key() == "sk-secret")
      #expect(hasKey == [true])
      // shown as a stand-in, never the key; committing it unchanged keeps the key
      #expect(w.keyField.stringValue == SettingsWindow.saved && w.keyStatus.stringValue == "已保存" && statusRowShown())
      w.commitKey(nil)
      #expect(keys.key() == "sk-secret" && hasKey == [true])
      let stored = try #require(d.persistentDomain(forName: name))
      #expect(!stored.values.contains { "\($0)".contains("sk-secret") })

      // a new key, committed by closing the window
      w.keyField.stringValue = "sk-other"
      w.window.close()
      #expect(keys.key() == "sk-other" && hasKey == [true, true])

      // cleared: removed
      w.keyField.stringValue = ""
      w.commitKey(nil)
      #expect(keys.key() == nil && hasKey == [true, true, false])
      #expect(w.keyStatus.stringValue == "" && !statusRowShown())
    }
  }

  /// Where tongtu is, however long its path: one line as wide as the fields, cut in its middle; the window keeps its
  /// width
  @MainActor @Test func theSettingsWindowSaysWhichTongtuInOneLineThatDoesNotWidenIt() throws {
    _ = NSApplication.shared
    let fm = FileManager.default
    let dir = fm.temporaryDirectory.appending(path: "tongtu-" + String(repeating: "a-long-folder-name-", count: 8))
    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: dir) }
    let exe = dir.appending(path: "tongtu")
    try Data("#!/bin/sh\n".utf8).write(to: exe)
    try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: exe.path)
    withDefaults { d, _ in
      let w = SettingsWindow(
        settings: AISettings(defaults: d), keys: MemoryKeyStore(), search: SearchSettings(defaults: d),
        searchKeys: MemoryKeyStore())
      w.window.setFrameOrigin(CGPoint(x: -30000, y: -30000))
      w.window.level = .underDesktop
      w.window.orderFrontRegardless()
      defer { w.window.close() }
      w.window.layoutIfNeeded()
      let width = w.window.frame.width
      w.tongtuField.stringValue = exe.path
      w.commitTongtu(nil)
      w.window.layoutIfNeeded()
      #expect(w.tongtuStatus.stringValue == "使用 \(exe.path)" && w.tongtuStatus.toolTip == exe.path)
      #expect(w.window.frame.width == width && width < 600)
      func drawnWidth(_ v: NSView) -> CGFloat { v.alignmentRect(forFrame: v.frame).width }
      #expect(drawnWidth(w.tongtuStatus) == drawnWidth(w.tongtuField))
      #expect(w.tongtuStatus.lineBreakMode == .byTruncatingMiddle && w.tongtuStatus.usesSingleLineMode)
    }
  }

  /// settings.ts ai.deepseekBaseUrl and ai.deepseekModel: empty, DeepSeek's, shown as the placeholders; what is typed is
  /// saved trimmed when committed, and the writer is made again with it
  @MainActor @Test func theSettingsWindowStoresTheAddressAndTheModel() {
    _ = NSApplication.shared
    withDefaults { d, _ in
      let keys = MemoryKeyStore("sk-1")
      let w = SettingsWindow(
        settings: AISettings(defaults: d), keys: keys, search: SearchSettings(defaults: d), searchKeys: MemoryKeyStore()
      )
      w.window.setFrameOrigin(CGPoint(x: -30000, y: -30000))
      w.window.level = .underDesktop
      w.window.orderFrontRegardless()
      defer { w.window.close() }
      var changed: [Bool] = []
      w.onKeyChange = { changed.append($0) }
      #expect(w.baseURLField.stringValue == "" && w.baseURLField.placeholderString == "https://api.deepseek.com")
      #expect(w.modelField.stringValue == "" && w.modelField.placeholderString == "deepseek-flash")

      w.baseURLField.stringValue = " http://127.0.0.1:8080/v1 "
      w.baseURLField.sendAction(w.baseURLField.action, to: w.baseURLField.target)
      #expect(AISettings(defaults: d).baseURL == "http://127.0.0.1:8080/v1" && changed == [true])
      // unchanged: nothing
      w.commitAI(nil)
      #expect(changed == [true])
      // the model, committed by closing the window; the writer asks that address with it
      w.modelField.stringValue = "qwen3"
      w.window.close()
      let ai = AISettings(defaults: d)
      #expect(ai.model == "qwen3" && changed == [true, true])
      let writer = ai.writer(keys: keys)
      #expect(writer.endpoint?.absoluteString == "http://127.0.0.1:8080/v1/chat/completions" && writer.model == "qwen3")

      // a new window shows what was saved; cleared, DeepSeek's again
      let again = SettingsWindow(
        settings: AISettings(defaults: d), keys: keys, search: SearchSettings(defaults: d), searchKeys: MemoryKeyStore()
      )
      #expect(again.baseURLField.stringValue == "http://127.0.0.1:8080/v1" && again.modelField.stringValue == "qwen3")
      again.baseURLField.stringValue = ""
      again.modelField.stringValue = ""
      again.commitAI(nil)
      #expect(
        AISettings(defaults: d).writer(keys: keys).endpoint?.absoluteString
          == "https://api.deepseek.com/chat/completions")
    }
  }

  /// settings.ts search.embeddingUrl, search.embeddingModel, search.rerank (on by default) and search.rerankModel in
  /// the defaults; the embedding key in its own store, never the AI key's, and handed to box only in memory
  @MainActor @Test func theSettingsWindowStoresTheSearchSettingsAndTheEmbeddingKey() {
    _ = NSApplication.shared
    #expect(KeychainKeyStore().account == "deepseekApiKey", "the AI key's item is where it was")
    #expect(KeychainKeyStore(account: SearchSettings.keyAccount).account == "embeddingApiKey")
    withDefaults { d, _ in
      let keys = MemoryKeyStore("sk-1")
      let searchKeys = MemoryKeyStore()
      let w = SettingsWindow(
        settings: AISettings(defaults: d), keys: keys, search: SearchSettings(defaults: d), searchKeys: searchKeys)
      w.window.setFrameOrigin(CGPoint(x: -30000, y: -30000))
      w.window.level = .underDesktop
      w.window.orderFrontRegardless()
      defer { w.window.close() }
      #expect(SearchSettings(defaults: d).embedder(keys: searchKeys) == nil, "no address: off")
      #expect(w.embeddingURLField.stringValue == "" && w.rerankSwitch.state == .on)

      w.embeddingURLField.stringValue = " http://127.0.0.1:11001/v1 "
      w.embeddingURLField.sendAction(w.embeddingURLField.action, to: w.embeddingURLField.target)
      w.embeddingModelField.stringValue = "embeddinggemma"
      w.rerankModelField.stringValue = "hs-rerank-1"
      w.rerankSwitch.state = .off
      w.rerankSwitch.sendAction(w.rerankSwitch.action, to: w.rerankSwitch.target)
      w.embeddingKeyField.stringValue = "ek-2"
      w.embeddingKeyField.sendAction(w.embeddingKeyField.action, to: w.embeddingKeyField.target)
      #expect(searchKeys.key() == "ek-2" && keys.key() == "sk-1")
      #expect(w.embeddingKeyField.stringValue == SettingsWindow.saved && w.embeddingKeyStatus.stringValue == "已保存")
      #expect(d.dictionaryRepresentation().values.contains { $0 as? String == "ek-2" } == false, "never in defaults")
      w.window.close()
      let s = SearchSettings(defaults: d)
      #expect(s.embeddingURL == "http://127.0.0.1:11001/v1" && s.embeddingModel == "embeddinggemma")
      #expect(s.rerank == false && s.rerankModel == "hs-rerank-1")
      #expect(
        s.embedder(keys: searchKeys)
          == BoxEmbedder(base: "http://127.0.0.1:11001/v1", model: "embeddinggemma", key: "ek-2"))
    }
  }
}
