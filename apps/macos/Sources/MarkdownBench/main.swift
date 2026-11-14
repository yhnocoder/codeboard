import Foundation

// The Markdown component's benches, without a window, each printing one JSON object (thread CPU or wall time, see each):
//   MarkdownBench --editor               what a key costs while a 1200-paragraph Note is edited (EditorBench)
//   MarkdownBench --notes                the synthetic Notes laid out and drawn, per look (NotesBench)
//   MarkdownBench --write-notes <folder> writes the synthetic Notes and their pictures there (for the web side)
let args = Array(CommandLine.arguments.dropFirst())
if args.contains("--editor") {
  try EditorBench.run()
} else if args.contains("--notes") {
  let out = try NotesBench.run()
  print(
    String(
      decoding: try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys, .prettyPrinted]), as: UTF8.self))
} else if let i = args.firstIndex(of: "--write-notes"), i + 1 < args.count {
  try SyntheticNotes.write(to: URL(filePath: args[i + 1]))
  print("wrote \(args[i + 1])")
} else {
  FileHandle.standardError.write(Data("usage: MarkdownBench --editor | --notes | --write-notes <folder>\n".utf8))
  exit(2)
}
