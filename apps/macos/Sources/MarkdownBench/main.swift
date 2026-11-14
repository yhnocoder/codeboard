import Foundation

// The Markdown component's benches, without a window, each printing one JSON object (thread CPU or wall time, see each):
//   MarkdownBench --editor               what a key costs while a 1200-paragraph Note is edited (EditorBench)
//   MarkdownBench --notes                the synthetic Notes laid out and drawn, per look (NotesBench)
//   MarkdownBench --write-notes <folder> writes the synthetic Notes and their pictures there (for the web side)
//   MarkdownBench --write-editor-note <file>  writes --editor's 1200-paragraph Note there (for the web side)
//   MarkdownBench --hold notes|editor    the forty Notes laid out and drawn at 2x (or the 1200-paragraph Note open for
//                                        editing, its view drawn), kept; prints "ready" and waits for stdin to close, so
//                                        a script can read the process's memory as it shows them
//   MarkdownBench --frames <script.json> --out <folder>  plays a scripted input sequence, writes a frame per step (Frames)
//   MarkdownBench --first                time until the forty Notes are first laid out and drawn, from a cold process
//                                        (fonts and engines loaded on the way), one Note alone, then all of them
// at the QoS of an app's main thread, which keeps it on the performance cores: a command-line process at the default may
// be moved to the efficiency cores partway, and its thread CPU per key with it
pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0)
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
} else if let i = args.firstIndex(of: "--write-editor-note"), i + 1 < args.count {
  try EditorBench.document(definitions: false).write(to: URL(filePath: args[i + 1]), atomically: true, encoding: .utf8)
  print("wrote \(args[i + 1])")
} else if let i = args.firstIndex(of: "--hold"), i + 1 < args.count {
  let kept = try Hold.make(args[i + 1])
  print("ready")
  fflush(stdout)
  while readLine() != nil {}
  withExtendedLifetime(kept) {}
} else if let i = args.firstIndex(of: "--frames"), i + 1 < args.count, let o = args.firstIndex(of: "--out"),
  o + 1 < args.count
{
  try MainActor.assumeIsolated { try Frames.run(URL(filePath: args[i + 1]), out: URL(filePath: args[o + 1])) }
} else if args.contains("--first") {
  let out = try Hold.first()
  print(String(decoding: try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), as: UTF8.self))
} else {
  FileHandle.standardError.write(Data("usage: MarkdownBench --editor | --notes | --write-notes <folder>\n".utf8))
  exit(2)
}
