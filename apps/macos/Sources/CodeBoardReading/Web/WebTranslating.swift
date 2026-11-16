import CodeBoardResources
import Foundation

extension WebReading {
  /// Translates blocks of a page, in order: as many texts out as in, or it throws. `from` the page's language when it
  /// says (BCP 47), `to` the language wanted
  public typealias Translator = @Sendable (_ texts: [String], _ from: String?, _ to: String) async throws -> [String]

  /// What saved pages are translated into
  static let translationLanguage = "zh"

  /// How a saved page is shown, as the reader's `setLanguage` names it
  enum Language: String, CaseIterable, Sendable {
    case original
    /// The translation under each block
    case both
    /// The translation in place of each block
    case translation
  }
}

/// A block of a saved page as the reader gives it (`blocks()`)
struct WebBlock: Equatable, Sendable {
  var id: String
  var kind: String
  /// The level the reader gives it (a heading's: 1 to 6)
  var level: Int?
  var text: String
  /// The reader's fingerprint of `text`
  var hash: String
  /// In the body under the page's rules
  var inBody: Bool
  /// False for code
  var translate: Bool

  /// One of `blocks()`'s; none when it lacks what a block has
  init?(script: Any) {
    guard let d = script as? [String: Any], let id = d["id"] as? String, let text = d["text"] as? String,
      let hash = d["textHash"] as? String
    else { return nil }
    self.init(
      id: id, kind: d["kind"] as? String ?? "", level: d["level"] as? Int, text: text, hash: hash,
      inBody: d["inBody"] as? Bool ?? false, translate: d["translate"] as? Bool ?? false)
  }

  init(id: String, kind: String, level: Int? = nil, text: String, hash: String, inBody: Bool, translate: Bool) {
    self.id = id
    self.kind = kind
    self.level = level
    self.text = text
    self.hash = hash
    self.inBody = inBody
    self.translate = translate
  }

  /// As the page's blocks file keeps it: a level only on a heading (FORMAT.md)
  var kept: PageBlock {
    PageBlock(id: id, kind: kind, level: kind == "heading" ? level : nil, hash: hash, text: text)
  }
}

/// What translating a saved page asks the AI for and in what order, and the asking. The page's body comes first, from
/// the block at the top of the window down, so that what the reader sees fills first; then the body above it; then
/// the rest, in the same order
enum WebTranslating {
  /// A batch's texts together, at most (one longer block goes alone): its answer in Chinese is at most about 0.6
  /// tokens a character, under 2000 tokens, which the shell's translator leaves twice the room for; and at the AI's
  /// usual pace it comes well inside the writer's minute
  static let batchCharacters = 3000
  /// Batches asked for at once
  static let concurrent = 3

  /// The blocks still to translate, in batches, best first: those to be translated, with text, and without a stored
  /// translation of the text they have now
  static func batches(_ blocks: [WebBlock], stored: [String: PageTranslations.Block], top: String?) -> [[WebBlock]] {
    let start = top.flatMap { id in blocks.firstIndex { $0.id == id } } ?? 0
    let wanted = blocks.enumerated().filter { _, b in
      b.translate && !b.text.allSatisfy(\.isWhitespace) && stored[b.id]?.hash != b.hash
    }
    let ordered = wanted.sorted { a, b in
      let ka = (a.element.inBody ? 0 : 1, a.offset >= start ? 0 : 1, a.offset)
      let kb = (b.element.inBody ? 0 : 1, b.offset >= start ? 0 : 1, b.offset)
      return ka < kb
    }
    var out: [[WebBlock]] = []
    var size = 0
    for (_, b) in ordered {
      if out.isEmpty || size + b.text.count > batchCharacters {
        out.append([])
        size = 0
      }
      out[out.count - 1].append(b)
      size += b.text.count
    }
    return out
  }

  /// How a run ended: the blocks left untranslated and the last reason
  struct Outcome {
    var failed: [String] = []
    var error: (any Error)?
  }

  struct WrongCount: LocalizedError {
    var asked: Int
    var got: Int
    var errorDescription: String? { "the AI answered \(got) texts for \(asked)" }
  }

  /// `batches` translated, `concurrent` at a time, each one's translations handed to `got` as they come, by block id.
  /// A batch that fails, or a text that comes back empty, leaves those blocks out. Cancelled: nothing more is asked for
  /// nor handed over
  @MainActor static func run(
    _ batches: [[WebBlock]], from: String?, to: String, translate: @escaping WebReading.Translator,
    got: ([String: PageTranslations.Block]) -> Void
  ) async -> Outcome {
    var outcome = Outcome()
    await withTaskGroup(of: (Int, Result<[String], any Error>).self) { group in
      func ask(_ i: Int) {
        let texts = batches[i].map(\.text)
        group.addTask {
          do {
            let out = try await translate(texts, from, to)
            return (
              i, out.count == texts.count ? .success(out) : .failure(WrongCount(asked: texts.count, got: out.count))
            )
          } catch {
            return (i, .failure(error))
          }
        }
      }
      var next = 0
      while next < min(concurrent, batches.count) {
        ask(next)
        next += 1
      }
      for await (i, result) in group {
        guard !Task.isCancelled else { break }
        switch result {
        case .success(let texts):
          var done: [String: PageTranslations.Block] = [:]
          for (b, t) in zip(batches[i], texts) {
            if t.allSatisfy(\.isWhitespace) {
              outcome.failed.append(b.id)
            } else {
              done[b.id] = .init(hash: b.hash, text: t)
            }
          }
          got(done)
        case .failure(let e):
          outcome.failed += batches[i].map(\.id)
          outcome.error = e
        }
        if next < batches.count {
          ask(next)
          next += 1
        }
      }
      group.cancelAll()
    }
    return outcome
  }
}
