import AVFoundation
import CodeBoardDiagnostics
import CoreMedia
import ScreenCaptureKit
import Synchronization

/// The recorded window as video.mp4: ScreenCaptureKit takes the app's own windows on the window's display (its menus,
/// popovers, sheets and panels with it) except the windows named, cropped to the window, at 60 frames a second with the
/// pointer, in points; the system's hardware encoder writes H.264. The video's time is the report's: 0 is the press
/// that started it
final class ScreenRecording: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  enum Failure: Error, CustomStringConvertible {
    case noPermission
    case windowNotShared
    case writer(String)

    var description: String {
      switch self {
      case .noPermission:
        "Screen Recording is not allowed for CodeBoard (System Settings › Privacy & Security › Screen & System Audio Recording); allow it, then record again"
      case .windowNotShared: "the window was not among what ScreenCaptureKit can record"
      case .writer(let s): "the video could not be written: \(s)"
      }
    }
  }

  let url: URL
  private let stream: SCStream
  private let writer: AVAssetWriter
  private let input: AVAssetWriterInput.SampleBufferReceiver
  private let queue = DispatchQueue(label: "bug-report.video", qos: .userInitiated)
  /// The press, on the host clock: the video starts there
  private let t0: Double
  /// The display's crop, kept to follow the window when it moves
  private let display: SCDisplay
  private let config: SCStreamConfiguration
  private struct State {
    var started = false
    var frames = 0
    var error: String?
    /// The first frame's time from the press: a few hundredths of a second when the sample times are the host clock's
    var first: Double?
  }
  private let state = Mutex(State())

  var frames: Int { state.withLock { $0.frames } }
  var error: String? { state.withLock { $0.error } }
  var firstFrame: Double? { state.withLock { $0.first } }

  private init(
    url: URL, stream: SCStream, writer: AVAssetWriter, input: AVAssetWriterInput.SampleBufferReceiver, t0: Double,
    display: SCDisplay,
    config: SCStreamConfiguration
  ) {
    self.url = url
    self.stream = stream
    self.writer = writer
    self.input = input
    self.t0 = t0
    self.display = display
    self.config = config
  }

  /// `window` and `excluding`: window numbers; `frame`: the window's frame in screen coordinates (y up, AppKit's)
  /// `ask`: the system asks for Screen Recording when it is not allowed (the report goes on without video meanwhile)
  static func start(window: Int, frame: CGRect, excluding: [Int], to url: URL, t0: Double, ask: Bool) async throws
    -> ScreenRecording
  {
    guard CGPreflightScreenCaptureAccess() || ask && CGRequestScreenCaptureAccess() else { throw Failure.noPermission }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let target = content.windows.first(where: { Int($0.windowID) == window }),
      let app = content.applications.first(where: { $0.processID == getpid() }),
      let display = content.displays.first(where: {
        $0.frame.intersects(target.frame)
          && $0.frame.contains(
            CGPoint(x: target.frame.midX, y: target.frame.midY))
      }) ?? content.displays.first
    else { throw Failure.windowNotShared }
    let others = content.windows.filter { excluding.contains(Int($0.windowID)) }
    let filter = SCContentFilter(display: display, including: [app], exceptingWindows: others)
    let config = SCStreamConfiguration()
    // points, not pixels: half the bytes on a Retina screen, and the input's points are the video's
    let w = Int(frame.width.rounded()) & ~1
    let h = Int(frame.height.rounded()) & ~1
    config.width = w
    config.height = h
    config.sourceRect = crop(target.frame, in: display.frame)
    config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
    config.showsCursor = true
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.queueDepth = 6
    config.preservesAspectRatio = true

    try? FileManager.default.removeItem(at: url)
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let input = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: w, AVVideoHeightKey: h,
        AVVideoCompressionPropertiesKey: [
          AVVideoAverageBitRateKey: max(2_000_000, w * h * 8), AVVideoExpectedSourceFrameRateKey: 60,
          AVVideoMaxKeyFrameIntervalKey: 60, AVVideoAllowFrameReorderingKey: false,
        ],
      ])
    guard writer.canAdd(input) else { throw Failure.writer("no video input") }
    // frames come as the screen changes: one the encoder is not ready for is dropped, never waited for
    let receiver = writer.inputReceiver(for: input)
    let stream = SCStream(filter: filter, configuration: config, delegate: nil)
    let rec = ScreenRecording(
      url: url, stream: stream, writer: writer, input: receiver, t0: t0, display: display, config: config)
    try stream.addStreamOutput(rec, type: .screen, sampleHandlerQueue: rec.queue)
    try await stream.startCapture()
    return rec
  }

  /// The window's part of the display, in the display's points from its top left (both rects in the global display
  /// space ScreenCaptureKit gives, y down)
  static func crop(_ window: CGRect, in display: CGRect) -> CGRect {
    CGRect(x: window.minX - display.minX, y: window.minY - display.minY, width: window.width, height: window.height)
  }

  /// These windows of the app are left out from now on (one opened while recording)
  func exclude(_ numbers: Set<Int>) async {
    guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true),
      let app = content.applications.first(where: { $0.processID == getpid() })
    else { return }
    let others = content.windows.filter { numbers.contains(Int($0.windowID)) }
    try? await stream.updateContentFilter(SCContentFilter(display: display, including: [app], exceptingWindows: others))
  }

  /// The window moved or changed size: the crop follows (the video keeps its size; a resized window is fitted in it)
  func follow(frame: CGRect, screenHeight: CGFloat) {
    // AppKit's y-up screen frame into the y-down global space
    let global = CGRect(x: frame.minX, y: screenHeight - frame.maxY, width: frame.width, height: frame.height)
    config.sourceRect = Self.crop(global, in: display.frame)
    stream.updateConfiguration(config) { _ in }
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, buffer.isValid,
      let info = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false)
        as? [[SCStreamFrameInfo: Any]],
      let raw = info.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete
    else { return }
    let started = state.withLock { s -> Bool in
      if s.started { return true }
      s.started = true
      return false
    }
    if !started {
      do { try writer.start() } catch {
        state.withLock { $0.error = String(describing: error) }
        return
      }
      // the sample times are the host clock's, as Diag.now(): starting the session at the press makes the video's
      // time the report's
      let pts = buffer.presentationTimeStamp.seconds
      state.withLock { $0.first = pts - t0 }
      let start = CMTime(seconds: min(t0, pts), preferredTimescale: 1_000_000)
      writer.startSession(atSourceTime: start)
      // players start a video at its first frame, not at the session's start: the first frame is shown from the press
      // too, so that the video's time is the report's from 0
      var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: start, decodeTimeStamp: .invalid)
      var lead: CMSampleBuffer?
      if pts > start.seconds,
        CMSampleBufferCreateCopyWithNewTiming(
          allocator: nil, sampleBuffer: buffer, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
          sampleBufferOut: &lead) == noErr, let lead
      {
        nonisolated(unsafe) let first = lead
        _ = try? input.appendImmediately(CMReadySampleBuffer(unsafeBuffer: first))
      }
    }
    // handed on and never touched here again
    nonisolated(unsafe) let frame = buffer
    if (try? input.appendImmediately(CMReadySampleBuffer(unsafeBuffer: frame))) == true {
      state.withLock { $0.frames += 1 }
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: any Error) {
    state.withLock { $0.error = String(describing: error) }
  }

  /// Ends the video; nil when no frame was written
  func stop() async -> URL? {
    try? await stream.stopCapture()
    return await withCheckedContinuation { (done: CheckedContinuation<URL?, Never>) in
      queue.async { [self] in
        guard state.withLock({ $0.started }), writer.status == .writing else { return done.resume(returning: nil) }
        input.finish()
        writer.finishWriting { [self] in
          if writer.status != .completed {
            state.withLock { $0.error = writer.error.map { String(describing: $0) } ?? "not finished" }
          }
          done.resume(returning: writer.status == .completed ? url : nil)
        }
      }
    }
  }
}
