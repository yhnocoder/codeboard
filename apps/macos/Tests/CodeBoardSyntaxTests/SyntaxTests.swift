import CodeBoardSyntax
import Foundation
import Testing

let highlighter = Highlighter()

/// The class of the code at the `nth` occurrence of `word` on the first line containing `marker`
func kind(_ lines: [String], _ tokens: [[Token]], _ marker: String, _ word: String, nth: Int = 0) -> TokenClass? {
  guard let row = lines.firstIndex(where: { $0.contains(marker) }) else {
    Issue.record("no line with \(marker)")
    return nil
  }
  let line = lines[row] as NSString
  var at = NSRange(location: -1, length: 0)
  for _ in 0...nth {
    let from = at.location + 1
    at = line.range(of: word, range: NSRange(location: from, length: line.length - from))
  }
  guard at.location != NSNotFound else {
    Issue.record("\(word) not on \(marker)")
    return nil
  }
  return tokens[row].first { $0.columns.contains(at.location) }?.kind
}

/// Tokens lie inside their line, in order, without overlapping
func wellFormed(_ lines: [String], _ tokens: [[Token]]) -> Bool {
  tokens.count == lines.count
    && zip(lines, tokens).allSatisfy { line, row in
      zip(row, row.dropFirst()).allSatisfy { $0.columns.upperBound <= $1.columns.lowerBound }
        && row.allSatisfy {
          !$0.columns.isEmpty && $0.columns.lowerBound >= 0 && $0.columns.upperBound <= line.utf16.count
        }
    }
}

func split(_ text: String) -> [String] { text.components(separatedBy: "\n") }

// The source and expectations of packages/host/test/highlight-cpp.test.ts, which the TypeScript highlighter passes
let cudaSource = split(
  #"""
  #include <cstdint>
  #include "launch.cuh"
  #define LAUNCH(kernel, n) { auto k = kernel; k<<<n, 128>>>(nullptr); } while (0)

  namespace ep {

  /* Reduce one tile
     per block */
  template <int kNumThreads, typename T>
  __global__ void __launch_bounds__(kNumThreads, 1)
  reduce(const T* __restrict__ x, float* out, int64_t n) {
      __shared__ float smem[32];
      const auto tid = static_cast<int>(threadIdx.x);
      float acc = 0.5f; unsigned long long mask = 0xffull;
      for (int i = tid; i < n; i += kNumThreads) acc += x[i];  // strided
      if (tid == 0 && out != nullptr) out[blockIdx.x] = acc;
      printf("done %d\n", tid);
  }

  struct Buffer : public Base {
      std::vector<torch::Tensor> tensors;
      int size() const noexcept { return this->tensors.size(); }
  };

  void launch(const float* x, float* out, int n, cudaStream_t s) {
      reduce<256, float><<<n / 256, 256, 0, s>>>(x, out, n);
      at::cuda::getCurrentCUDAStream();
  }

  }  // namespace ep
  """#)

@Suite struct CUDA {
  let tokens = highlighter.tokens(lines: cudaSource, language: "cuda-cpp")

  @Test func keywordsTypesFunctionsLiteralsCommentsAndThePreprocessor() {
    let want: [(String, String, TokenClass?, Int)] = [
      ("#include <cstdint>", "#include", .keyword, 0), ("#include <cstdint>", "<cstdint>", .string, 0),
      ("#include \"launch", "\"launch.cuh\"", .string, 0), ("namespace ep", "namespace", .keyword, 0),
      ("template <", "template", .keyword, 0), ("template <", "typename", .keyword, 0),
      ("template <", "int", .keyword, 0), ("reduce(const", "reduce", .function, 0),
      ("reduce(const", "const", .keyword, 0), ("reduce(const", "T", .function, 0),
      ("reduce(const", "int64_t", .keyword, 0), ("reduce(const", "float", .keyword, 0),
      ("const auto tid", "auto", .keyword, 0), ("const auto tid", "static_cast", .keyword, 0),
      ("float acc", "0.5f", .number, 0), ("float acc", "0xffull", .number, 0),
      ("float acc", "unsigned long long", .keyword, 0), ("for (int i", "for", .keyword, 0),
      ("for (int i", "+=", .keyword, 0), ("for (int i", "// strided", .comment, 0), ("for (int i", "x[i]", nil, 0),
      ("if (tid == 0", "nullptr", .number, 0), ("if (tid == 0", "0", .number, 0),
      ("printf(\"done", "printf", .function, 0), ("printf(\"done", "\"done", .string, 0),
      ("printf(\"done", "\\n", .string, 0), ("struct Buffer", "struct", .keyword, 0),
      ("struct Buffer", "Buffer", .function, 0), ("struct Buffer", "public", .keyword, 0),
      ("std::vector", "vector", .function, 0), ("std::vector", "Tensor", .function, 0), ("std::vector", "std", nil, 0),
      ("std::vector", "::", .punctuation, 0), ("int size()", "size", .function, 0),
      ("int size()", "noexcept", .keyword, 0), ("int size()", "this", .receiver, 0),
      ("int size()", "size", .function, 1), ("int size()", "return", .keyword, 0),
      ("void launch", "launch", .function, 0), ("void launch", "cudaStream_t", .function, 0),
      ("at::cuda::get", "getCurrentCUDAStream", .function, 0), ("at::cuda::get", "cuda", nil, 0),
      ("Reduce one tile", "Reduce", .comment, 0), ("per block", "per", .comment, 0),
    ]
    for (marker, word, cls, nth) in want {
      #expect(kind(cudaSource, tokens, marker, word, nth: nth) == cls, "\(word) on \(marker)")
    }
    #expect(wellFormed(cudaSource, tokens))
  }

  @Test func qualifiersBuiltinsLaunchBoundsAndTheLaunch() {
    let k = { (marker: String, word: String) in kind(cudaSource, tokens, marker, word) }
    #expect(k("__global__", "__global__") == .keyword)
    #expect(k("__global__", "__launch_bounds__") == .keyword)
    #expect(k("__global__", "kNumThreads") == nil)
    #expect(k("__restrict__", "__restrict__") == .keyword)
    #expect(k("__shared__", "__shared__") == .keyword)
    #expect(k("threadIdx", "threadIdx") == .number)
    #expect(k("out[blockIdx", "blockIdx") == .number)
    #expect(k("reduce<256", "reduce") == .function)
    #expect(k("reduce<256", "<<<") == .keyword)
    #expect(k("reduce<256", ">>>") == .keyword)
    // the template's angle brackets are not operators, and a call's template arguments are not coloured as types
    #expect(k("reduce<256", "<") == nil)
    #expect(k("reduce<256", "256") == .number)
    #expect(k("reduce<256", "float") == .keyword)
  }

  @Test func aDefineBodyIsColouredAsCode() {
    let k = { (word: String) in kind(cudaSource, tokens, "#define", word) }
    #expect(k("#define") == .keyword)
    #expect(k("LAUNCH") == .function)
    #expect(k("auto") == .keyword)
    #expect(k("<<<") == .keyword)
    #expect(k("128") == .number)
    #expect(k("nullptr") == .number)
    #expect(k("while") == .keyword)
  }

  @Test func cAndCppUseTheSameGrammar() {
    let lines = ["#include <stdio.h>", "static int sum(const int *a, size_t n) { return printf(\"%d\", n); }"]
    for language in ["c", "cpp"] {
      let t = highlighter.tokens(lines: lines, language: language)
      #expect(kind(lines, t, "static", "static") == .keyword)
      #expect(kind(lines, t, "static", "sum") == .function)
      #expect(kind(lines, t, "static", "size_t") == .keyword)
      #expect(kind(lines, t, "static", "printf") == .function)
      #expect(kind(lines, t, "<stdio", "<stdio.h>") == .string)
    }
  }
}

@Suite struct Python {
  // Expectations as the VS Code board's shiki grammar colours this snippet
  let lines = split(
    #"""
    @torch.compile(mode="max")
    class Model(nn.Module):
        """Doc {x} %s."""

        def forward(self, x: int = 3, *args) -> None:
            y = super().forward(x) + len(args)  # 中文
            if x is None and not y:
                raise ValueError(f"bad {x!r} {y:>4}")
            return cls.run("a %s {}" % y, key=b"%d", r=r"\d")
    """#)
  var tokens: [[Token]] { highlighter.tokens(lines: lines, language: "python") }

  @Test func colours() {
    let t = tokens
    let want: [(String, String, TokenClass?)] = [
      ("@torch", "@torch.compile", .number), ("@torch", "(", .punctuation), ("@torch", "mode", nil),
      ("@torch", "=", .operator), ("@torch", "\"max\"", .string),
      ("class", "class", .keyword), ("class", "Model", .function), ("class", "nn", .function),
      ("class", ".", .punctuation), ("class", "Module", .function), ("class", "(", nil),
      ("Doc", "\"\"\"Doc {x} %s.\"\"\"", .comment),
      ("def", "def", .keyword), ("def", "forward", .function), ("def", "self", .receiver), ("def", "x", nil),
      ("def", ":", .punctuation), ("def", "int", .number), ("def", "=", .operator), ("def", "3", .number),
      ("def", "*", .operator), ("def", "->", .punctuation), ("def", "None", .number),
      ("super", "super", .number), ("super", "forward", .function), ("super", "len", .function),
      ("super", "+", .operator), ("super", "# 中文", .comment),
      ("if x", "if", .keyword), ("if x", "is", .keyword), ("if x", "None", .number), ("if x", "and", .keyword),
      ("if x", "not", .keyword),
      ("raise", "raise", .keyword), ("raise", "ValueError", .number), ("raise", "f\"", .keyword),
      ("raise", "\"bad", .string), ("raise", "{", .number), ("raise", "x", nil), ("raise", "!r", .keyword),
      ("raise", ":>4", .keyword),
      ("return", "return", .keyword), ("return", "cls", .receiver), ("return", "run", .function),
      ("return", "\"a", .string), ("return", "%s", .number), ("return", "{}", .number), ("return", "% y", .operator),
      ("return", "key", nil), ("return", "b\"", .keyword), ("return", "%d", .number), ("return", "r\"", .keyword),
      ("return", "\\d", .string),
    ]
    for (marker, word, cls) in want { #expect(kind(lines, t, marker, word) == cls, "\(word) on \(marker)") }
    // the colon that ends a def or class line is plain, the others punctuation
    #expect(kind(lines, t, "def", ":", nth: 1) == nil)
    #expect(wellFormed(lines, t))
  }

  @Test func tritonAndTileLangArePython() {
    for language in ["triton", "tilelang"] {
      #expect(highlighter.tokens(lines: lines, language: language) == tokens)
    }
  }
}

@Suite struct Rust {
  // Expectations as the VS Code board's shiki grammar colours this snippet, except `self` as a parameter, which it
  // leaves plain
  let lines = split(
    #"""
    /// Doc 中文
    #[derive(Debug)]
    pub struct Store<'a, T: Send> { items: Vec<T>, name: &'a str }

    impl<T> Store<'_, T> {
        pub fn get(&mut self, i: usize) -> Option<&T> {
            let s = format!("{} {}", i, 'c');
            if let Some(v) = self.items.get(i) { return Some(v); }
            match i { 0..=9 => true, _ => false };
            HashMap::new(); None
        }
    }
    const MAX: u64 = 0x1f;
    """#)

  @Test func colours() {
    let t = highlighter.tokens(lines: lines, language: "rust")
    let want: [(String, String, TokenClass?)] = [
      ("/// Doc", "/// Doc 中文", .comment), ("#[derive", "derive", nil), ("#[derive", "Debug", .function),
      ("pub struct", "pub", .keyword), ("pub struct", "struct", .keyword), ("pub struct", "Store", .function),
      ("pub struct", "<", nil), ("pub struct", "'", nil), ("pub struct", "a", .function),
      ("pub struct", "T", .function),
      ("pub struct", ":", .operator), ("pub struct", "Vec", .function), ("pub struct", "&", .operator),
      ("pub struct", "str }", .function), ("pub struct", "items", nil), ("pub struct", "{", nil),
      ("impl<T>", "impl", .keyword), ("impl<T>", "_", .function),
      ("pub fn get", "fn", .keyword), ("pub fn get", "get", .function), ("pub fn get", "mut", .keyword),
      ("pub fn get", "self", .receiver), ("pub fn get", "usize", .function), ("pub fn get", "->", .operator),
      ("pub fn get", "Option", .function),
      ("let s", "let", .keyword), ("let s", "=", .operator), ("let s", "format!", .function),
      ("let s", "\"{} {}\"", .string), ("let s", "'c'", .string),
      ("if let", "Some", .function), ("if let", "self", .receiver), ("if let", ".", .keyword),
      ("if let", "items", nil), ("if let", "get", .function), ("if let", "return", .keyword),
      ("match", "match", .keyword), ("match", "0", .number), ("match", "..=", .keyword), ("match", "=>", .operator),
      ("match", "true", .number), ("match", "_", nil),
      ("HashMap", "HashMap", .function), ("HashMap", "::", .operator), ("HashMap", "new", .function),
      ("HashMap", "None", .function),
      ("const MAX", "const", .keyword), ("const MAX", "MAX", nil), ("const MAX", "u64", .function),
      ("const MAX", "0x1f", .number),
    ]
    for (marker, word, cls) in want { #expect(kind(lines, t, marker, word) == cls, "\(word) on \(marker)") }
    #expect(wellFormed(lines, t))
  }
}

/// A segment is a slice of its file and is highlighted without the file: each slice must look as it does in the whole file.
@Suite struct Slices {
  static let python = split(
    #"""
    class Engine:
        """Runs the model.

        It keeps the cache, it's warm
        and "quoted" text {x} here.
        """

        @torch.inference_mode()
        def step(self, seqs: list[Seq], n: int = 2) -> dict:
            out = {}
            for s in seqs:
                if s.done and not self.keep:
                    continue
                out[s.id] = self.model(s.ids, temp=0.5)  # 中文注释
            return out
    """#)
  static let cuda = split(
    #"""
    /* Reduce one tile
       per block, with a long
       explanation */
    template <typename T>
    __device__ T Buffer<T>::sum(int n) const {
        T acc = 0;
        for (int i = threadIdx.x; i < n; i += blockDim.x) acc += this->data[i];
        return static_cast<T>(acc);
    }
    """#)
  static let rust = split(
    #"""
    impl Store {
        /* the cache
           is warm */
        pub fn get(&mut self, i: usize) -> Option<&Item> {
            let x = self.items.get(i)?;
            if x.ok() { return Some(x); }
            None
        }
    }
    """#)

  /// File lines (1-based, inclusive), as a segment's `firstLine` and last line
  @Test(arguments: [
    ("python", 10, 15),  // an indented method body
    ("python", 8, 12),  // a decorated method, cut off in the middle
    ("python", 4, 15),  // starts inside a docstring with a quote and braces in it
    ("python", 3, 6),  // starts on a blank line inside a docstring
    ("cuda-cpp", 2, 9),  // starts inside a block comment
    ("cuda-cpp", 6, 9),  // a method body with its closing brace
    ("cuda-cpp", 7, 8),  // statements alone
    ("rust", 3, 8),  // starts inside a block comment
    ("rust", 5, 7),  // statements alone
  ])
  func aSliceLooksAsInItsFile(language: String, first: Int, last: Int) {
    let file = language == "python" ? Self.python : language == "rust" ? Self.rust : Self.cuda
    let whole = highlighter.tokens(lines: file, language: language)
    let slice = highlighter.tokens(lines: Array(file[first - 1...last - 1]), language: language)
    #expect(slice == Array(whole[first - 1...last - 1]))
  }

  @Test func aHiddenRangeStillOpensAndClosesItsString() {
    // A segment's lines include its hidden ones: here lines 2–4 (a docstring) are hidden on the card
    let lines = ["def f(x):", "    \"\"\"", "    Long text, don't stop", "    \"\"\"", "    return x"]
    let t = highlighter.tokens(lines: lines, language: "python")
    #expect(kind(lines, t, "Long", "Long") == .comment)
    #expect(kind(lines, t, "return", "return") == .keyword)
  }

  @Test func aDedentedSliceKeepsItsColumns() {
    let lines = ["\t\tif x:", "\t\t\treturn \"中\"", "", "\t\treturn None"]
    let t = highlighter.tokens(lines: lines, language: "python")
    #expect(t[1] == [Token(columns: 3..<9, kind: .keyword), Token(columns: 10..<13, kind: .string)])
    #expect(t[2] == [])
    #expect(t[3] == [Token(columns: 2..<8, kind: .keyword), Token(columns: 9..<13, kind: .number)])
  }
}

@Test func unknownLanguagesArePlainText() {
  for language in ["cobol", "plaintext", "", "typescript"] {
    #expect(highlighter.tokens(lines: ["a = 1", ""], language: language) == [[], []])
  }
  #expect(highlighter.tokens(lines: [], language: "python") == [])
  #expect(highlighter.tokens(lines: [""], language: "python") == [[]])
  #expect(highlighter.tokens(lines: ["", "   "], language: "cpp") == [[], []])
}

@Test func columnsAreUTF16() {
  // 中 and 文 are one code unit each, 😀 is two
  let python = ["s = \"中文😀\" + x  # 注释😀", "t = '''😀", "😀''' + y"]
  let p = highlighter.tokens(lines: python, language: "python")
  #expect(
    p[0] == [
      Token(columns: 2..<3, kind: .operator), Token(columns: 4..<10, kind: .string),
      Token(columns: 11..<12, kind: .operator), Token(columns: 16..<22, kind: .comment),
    ])
  #expect(p[2] == [Token(columns: 0..<5, kind: .string), Token(columns: 6..<7, kind: .operator)])
  let cpp = ["auto s = \"中😀\"; // 注释", "int y = s.size();"]
  let c = highlighter.tokens(lines: cpp, language: "cpp")
  #expect(c[0].last == Token(columns: 16..<21, kind: .comment))
  #expect(c[0].contains(Token(columns: 9..<14, kind: .string)))
  let rust = ["let s = \"😀\"; s.len()"]
  #expect(highlighter.tokens(lines: rust, language: "rust")[0].last == Token(columns: 16..<19, kind: .function))
}

@Test func tasksShareOneHighlighter() async {
  let alone = highlighter.tokens(lines: cudaSource, language: "cuda-cpp")
  let results = await withTaskGroup(of: [[Token]].self) { group in
    for _ in 0..<8 { group.addTask { highlighter.tokens(lines: cudaSource, language: "cuda-cpp") } }
    return await group.reduce(into: []) { $0.append($1) }
  }
  #expect(results.allSatisfy { $0 == alone })
}

/// Thread CPU time, so a busy machine does not fail the bound
func cpuSeconds(_ work: () -> Void) -> Double {
  let start = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
  work()
  return Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - start) / 1e9
}

@Test(arguments: ["python", "cuda-cpp"])
func twoThousandLinesInLinearTime(language: String) {
  let unit =
    language == "python"
    ? Slices.python + ["    def g(self, a):", "        return \"中\" % a  # c"]
    : cudaSource + ["// 注释", "int g(int a) { return a * 2; }"]
  let lines = Array(Array(repeating: unit, count: 2000 / unit.count + 1).joined().prefix(2000))
  var tokens: [[Token]] = []
  let seconds = cpuSeconds { tokens = highlighter.tokens(lines: lines, language: language) }
  #expect(tokens.count == 2000)
  // About 0.1 s in a debug build on an M-series Mac; something quadratic takes many times that
  #expect(seconds < 1.5)
}
