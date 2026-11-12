import CodeBoardCanvas
import Testing

@Test @MainActor func canvasIsLayerBacked() {
  #expect(CanvasView(frame: .zero).layer != nil)
}
