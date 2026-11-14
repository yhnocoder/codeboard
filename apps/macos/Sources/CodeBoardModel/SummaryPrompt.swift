import Foundation

// What the AI is asked for one summary and how its answer is read (host summaries.ts summaryPrompt, core summary.ts
// SumRequest, summaryExamples and readSummaryReply). The prompt texts are main's, byte for byte (SummaryTests compares
// them with packages/host/src/summaries.ts): swap a retuned version in there and here together.

/// What the AI is asked to summarize: the item, its cards' titles and contents, the user's edits of it and their edits
/// elsewhere as examples (core SumRequest; how long it is follows the content, never the layout)
public struct SummaryRequest: Equatable, Sendable {
  public enum CardKind: String, Sendable { case note, code, image, other }

  /// A card's title and content, or a child Section's title and summary
  public struct Material: Equatable, Sendable {
    public var title: String
    public var text: String

    public init(title: String, text: String) {
      self.title = title
      self.text = text
    }
  }

  /// A worked example: a Section's title, its content condensed, and the summary the user wrote for it
  public struct Example: Equatable, Sendable {
    public var title: String
    public var content: String
    public var summary: String

    public init(title: String, content: String, summary: String) {
      self.title = title
      self.content = content
      self.summary = summary
    }
  }

  public var key: SummaryKey
  public var title: String
  /// A card in no Section: one sentence and a short title; code: the title line is the signature, no title wanted
  public var card: CardKind?
  /// The card has no title of its own: the AI also writes a short one
  public var untitled: Bool
  /// The cards placed directly in a Section with child Sections, summarized as one: the AI writes their short title too
  public var group: Bool
  /// A header's one-sentence overview: the child Sections' titles and summaries (cards: the Section's direct cards)
  public var overview: [Material]?
  public var cards: [Material]
  public var sig: String
  /// summaryInput now: the summary written from this request carries it
  public var input: String
  /// The user's edits of this summary, newest first
  public var pairs: [Summary.Pair]
  /// The user's edits elsewhere (summaryExamples), in place of the prompt's own examples
  public var examples: [Example]

  public init(
    key: SummaryKey, title: String, card: CardKind? = nil, untitled: Bool = false, group: Bool = false,
    overview: [Material]? = nil, cards: [Material], sig: String, input: String, pairs: [Summary.Pair] = [],
    examples: [Example] = []
  ) {
    self.key = key
    self.title = title
    self.card = card
    self.untitled = untitled
    self.group = group
    self.overview = overview
    self.cards = cards
    self.sig = sig
    self.input = input
    self.pairs = pairs
    self.examples = examples
  }
}

/// THE summary prompt (host summaries.ts): {…} are filled from the request, and the user's own edited summaries take
/// the examples' places
public enum SummaryPrompt {
  /// SUMMARY_SYSTEM
  static let summarySystem = #"你为白板缩远视图写 Section 摘要。缩远时读者只扫一眼，所以摘要必须先让人抓住重点。只输出摘要正文本身，不要标题、不要引号、不要解释。"#
  /// SUMMARY_USER
  static let summaryUser = #"""
    下面是 4 个好摘要的例子（先是 Section 内容的浓缩，再是理想摘要），学它们的写法：先点出核心观点，细节舍得删；每个要点一句，要点多少决定写多长。

    例 1
    标题：使用 Kogge–Stone 算法进行 parallel scan
    内容：逐个输出各做一棵 reduction：所有输出可同时算，但最后一个仍要 N 步，工作量 O(N²)。更好的办法是让不同 reduction tree 共享部分和：Kogge–Stone 原为高速加法器提出，原地 scan，每轮步长 1、2、4、8 翻倍，每个位置加上左侧相隔一个步长的值，k 轮后保存最多 2^k 个输入的和。
    摘要：让各输出的 reduction tree **共享部分和**，log N 轮就能算完 scan。每轮**步长翻倍**，每个位置加上左边相隔一个步长的值。逐输出各算一遍则要 O(N²) 的功，**跨度也没降**。

    例 2
    标题：并行 radix sort
    内容：每次迭代依赖上一次的完整结果，所以迭代间串行，并行只在迭代内部。让每个线程负责一个键，取出当前位，0 的目标下标 = 键下标 − 此前 1 的个数，此前 1 的个数用 exclusive scan 求。kernel 代码：取 bit、gridExclusiveScan、算 dst、写出。
    摘要：radix sort 的并行只能在每次**迭代内部**，迭代之间必须串行。做法是**一个线程管一个键**，靠 exclusive scan 数出它前面有多少个 1，由此算出它在**输出里的位置**。

    例 3
    标题：用 warp 级原语对原子操作做 coalescing
    内容：简单 filter kernel 中各线程争用同一个输出计数器，同一 warp 的原子操作必然被硬件串行化。让 warp 协作：指定 leader，算出总增量，由 leader 做一次原子操作并广播起始位置，各线程算偏移。用 __activemask、__ffs、__popc、__shfl_sync，或 cooperative groups 的 coalesced_threads。代码两份。
    摘要：同一 warp 的原子操作**必然串行**，所以让一个 leader **代表整个 warp** 只发一次原子操作。leader 数出要保留的键，把计数器加上这个总数，再把拿到的起点**广播**给其他线程，各自按序号写出。

    例 4
    标题：Floyd-Warshall 算法
    内容：d(i,j,k) 表示只允许顶点 0..k 作中间点的最短距离，递推 min(d(i,j,k-1), d(i,k,k-1)+d(k,j,k-1))。自底向上从小 k 开始；k 的访问次序不重要；只需保存 O(N²) 而非 O(N³)。三层循环，内两层并行，同一 k 的所有单元算完才能进下一个 k。CUDA kernel 每个线程算一格，用 shared 缓存 dist[i][k]。
    摘要：每个中间顶点 k 都要把整张距离表更新一遍，而同一个 k 内**各单元互不依赖**，所以**一个线程算一格**；不同 k 之间要**全局同步**，每个 k 启动一次 kernel。

    ---

    Section 标题：{标题}

    这个 Section 里的卡片：
    {卡片内容，笔记卡去掉图片和标签，代码卡前 80 行，共最多 6000 字}

    写法：
    1. 第一句只说这个 Section 的核心观点：读者读完只记住一件事的话，该记住什么。用判断或结论的口吻，说“为什么／怎么做才成立”，不要罗列“介绍了……、包括……”。
    2. 后面的句子按重要性支撑第一句：先是最关键的原因或做法，再是次要的补充。越往后越可以删。
    3. 数字、API 名、例子，只在它们本身就是重点时才写；细节、公式推导、参数、代码里的变量名一律省略。
    4. 加粗（用 **…** 包起来）每个重要句子的关键短语：大约每 40 字一处，最多 3 处；不到 50 字的摘要正好一处。每处 2–10 个字；加粗的字合起来不超过全文的四分之一。第一处加粗放在核心观点上。不要加粗数字或 API 名。
    5. 不要重复标题；用中文；英文术语可以保留。

    长度：跟着卡片内容有多少要点走，和摆放的地方无关。卡片里每个独立的关键要点写一句：内容单薄的 Section 一句就够，内容丰富的最多六句左右。绝不凑字数，也不要硬塞细节；一般不超过 200 字。
    只输出摘要正文。

    """#
  /// SUMMARY_PAIRS_INTRO
  static let pairsIntro = #"这个 Section 的摘要用户改过（从新到旧）。照用户的改法写：保留他的强调、措辞和长度偏好，只按卡片现在的内容更新；几次改法冲突的地方以较新的为准，一致的偏好都保留。"#
  /// SUMMARY_PAIR
  static let pair = #"""
    第 {序号} 次（{新旧}）AI 原来写的：
    {AI 原文}
    用户改成：
    {用户改的}
    """#
  /// SUMMARY_UNTITLED
  static let untitledAsk = #"""
    这张卡没有标题：另外给它起一个短标题，不超过 12 个字（英文不超过 6 个词），说它讲的是什么，不要照抄原文的第一句。
    只输出 JSON：{"title": "短标题", "text": "摘要正文"}，不要别的。
    """#
  /// SUMMARY_GROUP
  static let groupAsk = #"""
    这些卡片直接放在这个 Section 里，不属于它的任何子 Section；它们合起来写一份摘要。另外给它们起一个短标题，不超过 12 个字（英文不超过 6 个词），说它们讲的是什么，不要用 Section 的标题。
    只输出 JSON：{"title": "短标题", "text": "摘要正文"}，不要别的。
    """#
  /// OVERVIEW_SYSTEM
  static let overviewSystem = #"你为白板缩远视图里一个外层 Section 写一句概述，放在它的标题下面。只输出这一句本身，不要标题、不要引号、不要解释。"#
  /// OVERVIEW_USER
  static let overviewUser = #"""
    外层 Section 标题：{标题}

    它的子 Section（标题和各自的摘要）：
    {子 Section}
    {直属卡片}
    写法：
    1. 只写一句话：这一组整体讲什么、子题之间是什么关系（先后、对照、因果），读者扫一眼就知道这一块在干什么。子 Section 各有自己的摘要，不要逐个复述，也不要罗列“包括……”。
    2. 加粗（用 **…** 包起来）这句里最关键的一个短语，2–10 个字；不要加粗数字或 API 名。
    3. 不要重复标题；用中文；英文术语可以保留。越短越好，绝不凑字数。
    只输出这一句。

    """#

  /// How many examples the prompt shows
  static let exampleCount = 4

  /// The prompt's own examples, in its order
  static let builtIn = summaryUser.matches(of: /例 (\d+)\n标题：(.*)\n内容：(.*)\n摘要：(.*)/).map { m in
    SummaryRequest.Example(title: String(m.output.2), content: String(m.output.3), summary: String(m.output.4))
  }

  /// The system and user messages for one request (host summaryPrompt)
  public static func make(_ r: SummaryRequest) -> (system: String, user: String) {
    let cards = r.cards.map { "【\($0.title)】\n\(jsTrim($0.text))" }.joined(separator: "\n\n")
    if let overview = r.overview {
      var user = fill(
        overviewUser,
        [
          "标题": r.title,
          "子 Section": overview.map { k in
            let t = jsTrim(k.text)
            return "【\(k.title)】\n\(t.isEmpty ? "（还没有摘要）" : t)"
          }.joined(separator: "\n\n"),
          "直属卡片": r.cards.isEmpty ? "" : "\n直接放在这个 Section 里、不属于任何子 Section 的卡片：\n\(cards)\n",
        ])
      if !r.pairs.isEmpty { user = withPairs(user, r.pairs, "只输出这一句。") }
      return (overviewSystem, user)
    }
    let examples = (r.examples + builtIn).prefix(exampleCount).enumerated().map { i, e in
      "例 \(i + 1)\n标题：\(e.title)\n内容：\(e.content)\n摘要：\(e.summary)"
    }.joined(separator: "\n\n")
    let first = summaryUser.range(of: "例 1\n", options: .literal)!.lowerBound
    let rest = summaryUser.range(of: "\n\n---\n", options: .literal)!.lowerBound
    var user = String(summaryUser[..<first]) + examples + String(summaryUser[rest...])
    user = fill(user, ["标题": r.title, "卡片内容，笔记卡去掉图片和标签，代码卡前 80 行，共最多 6000 字": cards])
    if !r.pairs.isEmpty { user = withPairs(user, r.pairs, "只输出摘要正文。") }
    if r.untitled || r.group {
      user = before(user, last: "只输出摘要正文。") + (r.group ? groupAsk : untitledAsk)
      var system = summarySystem
      if let t = system.range(of: "不要标题、", options: .literal) { system.removeSubrange(t) }
      return (system, user)
    }
    return (summarySystem, user)
  }

  /// t.replace(/\{([^{}]+)\}/g, (m, k) => f[k] ?? m): one pass, what is put in is not looked at again
  static func fill(_ t: String, _ f: [String: String]) -> String {
    let u = Array(t.utf16)
    var out: [UInt16] = []
    var i = 0
    while i < u.count {
      if u[i] == 0x7B {
        var j = i + 1
        while j < u.count && u[j] != 0x7D && u[j] != 0x7B { j += 1 }
        if j < u.count && u[j] == 0x7D && j > i + 1 {
          if let v = f[String(decoding: u[(i + 1)..<j], as: UTF16.self)] { out += v.utf16 } else { out += u[i...j] }
          i = j + 1
          continue
        }
      }
      out.append(u[i])
      i += 1
    }
    return String(decoding: out, as: UTF16.self)
  }

  /// What is before the last `line` (JavaScript's lastIndexOf; -1 when it is not there)
  private static func before(_ s: String, last line: String) -> String {
    guard let r = s.range(of: line, options: [.literal, .backwards]) else { return String(s.utf16.dropLast()) ?? "" }
    return String(s[..<r.lowerBound])
  }

  /// The user's edits of this summary (newest first), before the prompt's last line
  private static func withPairs(_ user: String, _ pairs: [Summary.Pair], _ lastLine: String) -> String {
    let n = pairs.count
    let blocks = pairs.enumerated().map { i, p in
      fill(
        pair,
        [
          "序号": String(i + 1), "新旧": i == 0 ? "最新" : i == n - 1 ? "最旧" : "较旧", "AI 原文": p.ai, "用户改的": p.user,
        ])
    }
    let head = before(user, last: lastLine)
    let tail = user.range(of: lastLine, options: [.literal, .backwards]).map { String(user[$0.lowerBound...]) } ?? ""
    return head + ([pairsIntro] + blocks).joined(separator: "\n\n") + "\n" + tail
  }
}

/// The AI's answer, a summary (core readSummaryReply): JSON as asked, or a bare text taken as the body. About one bold
/// key phrase per 40 chars is kept (exactly one under 50, maxBold at most). nil: empty
public func readSummaryReply(_ raw: String, _ r: SummaryRequest, at: Double) -> Summary? {
  let t = jsTrim(re(#"^```(?:json)?\s*\n?|\n?```$"#).replace(jsTrim(raw)) { _ in "" })
  var text = t
  var title: String?
  if let j = try? JSONSerialization.jsonObject(with: Data(t.utf8), options: [.fragmentsAllowed]) as? [String: Any] {
    if let x = j["text"] as? String { text = x }
    if let x = j["title"] as? String { title = x }
  }
  text = jsTrim(text)
  let len = text.replacingOccurrences(of: "**", with: "").utf16.count
  let most = len < 50 ? 1 : min(SummaryRules.maxBold, max(1, Int((Double(len) / 40).rounded(.toNearestOrAwayFromZero))))
  var bold = 0
  text = re(#"\*\*(.+?)\*\*"#).replace(text) { m in
    bold += 1
    return bold <= most ? "**\(m[1])**" : m[1]
  }
  guard !text.isEmpty else { return nil }
  var s = Summary(text: text, at: at, sig: r.sig, pairs: r.pairs, input: r.input)
  if let x = title.map(jsTrim), !x.isEmpty, (r.card != nil && r.card != .code) || r.group { s.title = x }
  return s
}

/// Asks the writer for one summary (host summarize, after its key check: the writer does that). Never throws
public func summarize(_ r: SummaryRequest, with writer: some SummaryWriter, now: Double) async -> Result<
  Summary, SummaryFailure
> {
  let p = SummaryPrompt.make(r)
  do {
    let raw = try await writer.write(system: p.system, user: p.user)
    guard let s = readSummaryReply(raw, r, at: now) else { return .failure(.http("DeepSeek returned an empty answer")) }
    return .success(s)
  } catch {
    return .failure(error)
  }
}
