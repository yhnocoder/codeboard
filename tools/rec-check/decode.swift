// rec-check's decoder when ffmpeg is not installed: AVFoundation, compiled once by tools/rec-check.mjs.
//   info <video>                       JSON: width, height, fps, duration
//   decode <video> <width> <height>    per frame on stdout: its time (Float64, seconds) then width × height luma bytes
//   clip <video> <out.mp4> <start> <duration>
//   sheet <video> <out.png> <spec.json> {cell, cols, items: [{t, rect: [x, y, w, h] | null}]}, rects in video pixels
import AVFoundation
import Accelerate
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func fail(_ s: String) -> Never {
  FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
  exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: decode info|decode|clip|sheet <video> …") }
let asset = AVURLAsset(url: URL(fileURLWithPath: args[2]))
guard let track = try await asset.loadTracks(withMediaType: .video).first else { fail("no video track") }

switch args[1] {
case "info":
  let (size, fps) = try await track.load(.naturalSize, .nominalFrameRate)
  let duration = try await asset.load(.duration).seconds
  print("{\"width\":\(Int(size.width)),\"height\":\(Int(size.height)),\"fps\":\(fps),\"duration\":\(duration)}")

case "decode":
  let w = Int(args[3])!, h = Int(args[4])!
  let reader = try AVAssetReader(asset: asset)
  let out = AVAssetReaderTrackOutput(
    track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange])
  out.alwaysCopiesSampleData = false
  reader.add(out)
  reader.startReading()
  var luma = [UInt8](repeating: 0, count: w * h)
  setvbuf(stdout, nil, _IOFBF, 1 << 22)
  while let sample = out.copyNextSampleBuffer() {
    guard let px = CMSampleBufferGetImageBuffer(sample) else { continue }
    var t = CMSampleBufferGetPresentationTimeStamp(sample).seconds
    CVPixelBufferLockBaseAddress(px, .readOnly)
    var src = vImage_Buffer(
      data: CVPixelBufferGetBaseAddressOfPlane(px, 0), height: vImagePixelCount(CVPixelBufferGetHeightOfPlane(px, 0)),
      width: vImagePixelCount(CVPixelBufferGetWidthOfPlane(px, 0)), rowBytes: CVPixelBufferGetBytesPerRowOfPlane(px, 0))
    luma.withUnsafeMutableBytes { dst in
      var d = vImage_Buffer(data: dst.baseAddress, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: w)
      if Int(src.width) == w && Int(src.height) == h {
        vImageCopyBuffer(&src, &d, 1, vImage_Flags(kvImageNoFlags))
      } else {
        vImageScale_Planar8(&src, &d, nil, vImage_Flags(kvImageNoFlags))
      }
    }
    CVPixelBufferUnlockBaseAddress(px, .readOnly)
    fwrite(&t, 8, 1, stdout)
    if fwrite(luma, 1, w * h, stdout) != w * h { exit(0) }  // the reader stopped listening
  }
  fflush(stdout)
  if reader.status == .failed { fail(reader.error?.localizedDescription ?? "decode failed") }

case "clip":
  let url = URL(fileURLWithPath: args[3])
  try? FileManager.default.removeItem(at: url)
  guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPreset1280x720) else { fail("no export") }
  session.timeRange = CMTimeRange(
    start: CMTime(seconds: Double(args[4])!, preferredTimescale: 600), duration: CMTime(seconds: Double(args[5])!, preferredTimescale: 600))
  try await session.export(to: url, as: .mp4)

case "sheet":
  struct Item: Decodable { let t: Double; let rect: [Double]? }
  struct Spec: Decodable { let cell: Int; let cols: Int; let items: [Item] }
  let spec = try JSONDecoder().decode(Spec.self, from: Data(contentsOf: URL(fileURLWithPath: args[4])))
  let size = try await track.load(.naturalSize)
  let k = Double(spec.cell) / size.width
  let cw = spec.cell, ch = Int((size.height * k).rounded())
  let rows = (spec.items.count + spec.cols - 1) / spec.cols
  let gen = AVAssetImageGenerator(asset: asset)
  gen.requestedTimeToleranceBefore = .zero
  gen.requestedTimeToleranceAfter = .zero
  gen.maximumSize = CGSize(width: cw, height: ch)
  guard
    let ctx = CGContext(
      data: nil, width: cw * spec.cols, height: ch * rows, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { fail("no context") }
  ctx.setFillColor(gray: 0, alpha: 1)
  ctx.fill(CGRect(x: 0, y: 0, width: cw * spec.cols, height: ch * rows))
  ctx.setStrokeColor(red: 1, green: 0.1, blue: 0.1, alpha: 0.9)
  ctx.setLineWidth(3)
  for (n, item) in spec.items.enumerated() {
    let x = Double((n % spec.cols) * cw), y = Double((rows - 1 - n / spec.cols) * ch)  // CoreGraphics counts rows from the bottom
    let image = try await gen.image(at: CMTime(seconds: item.t, preferredTimescale: 60000)).image
    ctx.draw(image, in: CGRect(x: x, y: y, width: Double(cw), height: Double(ch)))
    if let r = item.rect {
      ctx.stroke(CGRect(x: x + r[0] * k, y: y + Double(ch) - (r[1] + r[3]) * k, width: r[2] * k, height: r[3] * k))
    }
  }
  guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[3]) as CFURL, UTType.png.identifier as CFString, 1, nil)
  else { fail("cannot write \(args[3])") }
  CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
  CGImageDestinationFinalize(dest)

default:
  fail("unknown command \(args[1])")
}
