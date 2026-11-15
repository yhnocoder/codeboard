import AppKit
import MarkdownDemoKit

// A window to try the Markdown component in (MarkdownDemoKit has it, so a driver can run it in its own process)
try MainActor.assumeIsolated { try runMarkdownDemo(arguments: Array(CommandLine.arguments.dropFirst())) }
