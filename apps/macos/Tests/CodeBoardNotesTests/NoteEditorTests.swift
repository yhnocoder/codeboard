import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardNotes

/// Pictures pasted on the canvas, kept in the board's images/ by their content (NoteEditor.store)
@MainActor @Suite struct NoteEditorTests {
  @Test func aPictureIsStoredByItsContentOnce() throws {
    let folder = FileManager.default.temporaryDirectory.appending(path: "editor-images-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: folder) }
    // a 2 × 3 PNG
    let ctx = try #require(
      CGContext(
        data: nil, width: 2, height: 3, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    let image = try #require(ctx.makeImage())
    let png = try #require(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]))
    let url = "data:image/png;base64," + png.base64EncodedString()
    let a = try #require(try NoteEditor.store(dataURL: url, in: folder))
    #expect(a.hasPrefix("images/") && a.hasSuffix("-2x3.png") && a.count == "images/".count + 16 + "-2x3.png".count)
    #expect(try NoteEditor.store(dataURL: url, in: folder) == a)
    #expect(FileManager.default.fileExists(atPath: folder.appending(path: a).path(percentEncoded: false)))
    #expect(try NoteEditor.store(dataURL: "data:text/plain;base64,aGVsbG8=", in: folder) == nil)
  }
}
