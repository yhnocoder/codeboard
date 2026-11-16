import Foundation
import Synchronization
import Testing

@testable import CodeBoardModel
@testable import CodeBoardShell

// Web pages' translator over the summary writer, without the network: a URL protocol of its own answers from memory
// and keeps what was sent, the key in memory. Neither the Keychain nor the app's defaults are read.

/// Answers every request with `answer` (status and body), and keeps the requests' bodies
final class TranslateStub: URLProtocol, @unchecked Sendable {
  private static let state = Mutex<(answer: (Int, String), bodies: [Data])>(((200, "{}"), []))

  static func reset(_ status: Int, _ body: String) { state.withLock { $0 = ((status, body), []) } }
  static var bodies: [Data] { state.withLock { $0.bodies } }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    // inside a URL protocol the body arrives as a stream
    var data = Data()
    if let stream = request.httpBodyStream {
      stream.open()
      var buf = [UInt8](repeating: 0, count: 4096)
      while case let n = stream.read(&buf, maxLength: buf.count), n > 0 { data.append(buf, count: n) }
      stream.close()
    }
    let (status, body) = Self.state.withLock {
      $0.bodies.append(data)
      return $0.answer
    }
    let resp = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
    client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

@Suite(.serialized) struct ShellTranslateTests {
  func translator(key: String? = "sk-test") -> @Sendable ([String], String?, String) async throws -> [String] {
    Shell.translator {
      let c = URLSessionConfiguration.ephemeral
      c.protocolClasses = [TranslateStub.self]
      return OpenAISummaryWriter(
        baseURL: "http://ai.test", keys: MemoryKeyStore(key), session: URLSession(configuration: c))
    }
  }

  func reply(_ content: String) -> String {
    String(
      decoding: try! JSONSerialization.data(withJSONObject: ["choices": [["message": ["content": content]]]]),
      as: UTF8.self)
  }

  func failure(_ body: () async throws -> [String]) async -> String? {
    do {
      _ = try await body()
      return nil
    } catch {
      return error.localizedDescription
    }
  }

  @Test func theBlocksGoNumberedInOneSummaryRequestAndTheirTranslationsComeBackInOrder() async throws {
    TranslateStub.reset(200, reply("Here:\n```json\n[\"一个 **标题**\", \"第 2 段\"]\n```"))
    let out = try await translator()(["A **heading**", "Paragraph 2"], "en", "zh")
    #expect(out == ["一个 **标题**", "第 2 段"])
    let sent = try #require(TranslateStub.bodies.first)
    let body = try #require(try JSONSerialization.jsonObject(with: sent) as? [String: Any])
    let messages = try #require(body["messages"] as? [[String: String]])
    #expect(messages.map { $0["role"] } == ["system", "user"])
    let system = try #require(messages[0]["content"])
    #expect(system.contains("Simplified Chinese (zh-Hans)") && system.contains("The page is in English (en)."))
    #expect(system.contains("JSON array of strings") && system.contains("same order"))
    let user = try #require(messages[1]["content"]?.data(using: .utf8))
    let blocks = try #require(try JSONSerialization.jsonObject(with: user) as? [[String: Any]])
    #expect(
      blocks.map { $0["n"] as? Int } == [1, 2]
        && blocks.map { $0["text"] as? String } == ["A **heading**", "Paragraph 2"])
    #expect(body["model"] as? String == "deepseek-flash", "the summary writer's request")
  }

  @Test func withoutThePagesLanguageThePromptSaysNone() {
    #expect(!Shell.translationPrompt(from: nil, to: "zh").contains("The page is in"))
    #expect(Shell.translationPrompt(from: "fr", to: "zh").contains("French (fr)"))
  }

  @Test func anAnswerThatIsNotOneTranslationPerBlockFails() async {
    TranslateStub.reset(200, reply(#"["只有一个"]"#))
    #expect(
      await failure { try await translator()(["One", "Two"], nil, "zh") }?.contains("1 translations for 2") == true)
    TranslateStub.reset(200, reply("Sorry, I can't."))
    #expect(await failure { try await translator()(["One"], nil, "zh") }?.contains("not a list") == true)
  }

  @Test func theSummaryWritersFailuresSayWhatWentWrong() async {
    TranslateStub.reset(200, reply("[]"))
    #expect(
      await failure { try await translator(key: nil)(["One"], nil, "zh") }?.contains("no DeepSeek API key") == true)
    #expect(TranslateStub.bodies.isEmpty, "nothing sent without a key")
    TranslateStub.reset(401, #"{"error":{"message":"bad key"}}"#)
    #expect(await failure { try await translator()(["One"], nil, "zh") } == "DeepSeek rejected the API key")
    TranslateStub.reset(500, #"{"error":{"message":"boom"}}"#)
    #expect(await failure { try await translator()(["One"], nil, "zh") } == "DeepSeek: boom")
  }
}
