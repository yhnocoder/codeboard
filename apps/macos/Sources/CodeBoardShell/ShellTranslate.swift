import CodeBoardModel
import CodeBoardReading
import Foundation

// Saved web pages translated block by block through the AI summaries are rewritten with: the same address, model and
// key, the same request. The settings and the key are read only when a page is translated.

extension Shell {
  /// Web tabs' translator over the AI settings in the app's defaults and the key in the Keychain
  static let webTranslate: WebReading.Translator = translator {
    translationWriter(AISettings(defaults: .standard), keys: KeychainKeyStore())
  }

  /// A batch of WebTranslating.batchCharacters, in Chinese, as a JSON list: at most about 0.6 tokens a character (a
  /// page in Chinese or Japanese; English comes out in fewer characters than it had), and a few tokens a block for the
  /// list. Twice that and more, so that an answer is never cut short
  nonisolated static let translationAnswerTokens = 4096

  /// The summaries' writer as `ai` and `keys` describe it, with room for a batch's translations
  nonisolated static func translationWriter(
    _ ai: AISettings, keys: any KeyStore, session: URLSession = .shared
  ) -> OpenAISummaryWriter {
    var w = ai.writer(keys: keys, session: session)
    w.answerTokens = translationAnswerTokens
    return w
  }

  /// A translator asking `writer`'s model once per batch: the texts numbered in, their translations as a JSON list out
  nonisolated static func translator(_ writer: @escaping @Sendable () -> any SummaryWriter) -> WebReading.Translator {
    { texts, from, to in
      let user = String(
        decoding: try JSONSerialization.data(
          withJSONObject: texts.enumerated().map { ["n": $0.offset + 1, "text": $0.element] }, options: [.sortedKeys]),
        as: UTF8.self)
      let answer: String
      do {
        answer = try await writer().write(system: translationPrompt(from: from, to: to), user: user)
      } catch {
        throw TranslateFailure(error)
      }
      return try translations(in: answer, count: texts.count)
    }
  }

  nonisolated static func translationPrompt(from: String?, to: String) -> String {
    let source = from.map { " The page is in \(languageName($0))." } ?? ""
    return """
      You translate blocks of a web page into \(languageName(to)).\(source) The user sends a JSON array of numbered \
      blocks, {"n": number, "text": block}. Translate each block's text on its own. Keep inline formatting marks \
      (such as **, *, _, `, ~~, [text](url) and HTML tags), numbers, formulas, code, addresses and names as they are, \
      translating only the prose around them. Answer with a JSON array of strings and nothing else: one translation \
      per block, as many as there are blocks, in the same order, without the numbers.
      """
  }

  /// "zh" is the Simplified Chinese the board's Chinese is written in
  nonisolated static func languageName(_ code: String) -> String {
    if code == "zh" { return "Simplified Chinese (zh-Hans)" }
    return Locale(identifier: "en").localizedString(forIdentifier: code).map { "\($0) (\(code))" } ?? code
  }

  /// The JSON list of strings in the model's answer, which may come in a code fence
  nonisolated static func translations(in answer: String, count: Int) throws -> [String] {
    guard let start = answer.firstIndex(of: "["), let end = answer.lastIndex(of: "]"), start < end,
      let list = try? JSONDecoder().decode([String].self, from: Data(answer[start...end].utf8))
    else { throw TranslateFailure(message: "the AI's answer was not a list of translations") }
    guard list.count == count else {
      throw TranslateFailure(message: "the AI answered \(list.count) translations for \(count) blocks")
    }
    return list
  }
}

/// Why a batch was not translated, as the language buttons say it
struct TranslateFailure: LocalizedError, Equatable {
  var message: String
  var errorDescription: String? { message }

  init(message: String) { self.message = message }

  init(_ error: any Error) {
    message =
      switch error as? SummaryFailure {
      case .noKey: "no DeepSeek API key (set it in Settings…, ⌘,)"
      case .badKey: "DeepSeek rejected the API key"
      case .balance: "the DeepSeek account balance is used up"
      case .timeout: "DeepSeek didn't answer in time"
      case .network(let m): "couldn't reach DeepSeek: \(m)"
      case .http(let m): "DeepSeek: \(m)"
      case nil: error.localizedDescription
      }
  }
}
