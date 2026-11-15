import AppKit

// The Markdown component's demo: `MarkdownEditorDemo [file.md]`
MainActor.assumeIsolated {
  let app = NSApplication.shared
  app.setActivationPolicy(.regular)
  let file = CommandLine.arguments.dropFirst().first.map { URL(filePath: $0) }
  do {
    let demo = try EditorDemo(file: file)
    app.delegate = demo
    app.run()
  } catch {
    FileHandle.standardError.write(Data("cannot open \(file?.path ?? "the file"): \(error)\n".utf8))
    exit(1)
  }
}
