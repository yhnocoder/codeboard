import AppKit
import Testing

@testable import CodeBoardMarkdownUI

/// SVG stylesheets the system renderer cannot take by itself, drawn for a light and a dark look: each case's middle
/// pixel is the colour the look should give (her figures drew their dark colours on light paper)
@MainActor @Suite struct SVGStyleTests {
  func middle(_ svg: String, dark: Bool) -> (r: CGFloat, b: CGFloat) {
    guard let i = MarkdownSVG.image(Data(svg.utf8), pixelWidth: 100, dark: dark) else { return (-1, -1) }
    let c = NSBitmapImageRep(cgImage: i).colorAt(x: 50, y: 50)!.usingColorSpace(.sRGB)!
    return (c.redComponent, c.blueComponent)
  }

  @Test func colourSchemesVariablesAndLightDarkFollowTheLook() {
    let h = "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100' viewBox='0 0 100 100'>"
    let r = "<rect class='a' width='100' height='100'/></svg>"
    // each: light red, dark blue
    let cases = [
      h + "<style>.a{fill:red} @media (prefers-color-scheme: dark){.a{fill:blue}}</style>" + r,
      h + "<style>.a{fill:blue} @media (prefers-color-scheme: light){.a{fill:red}}</style>" + r,
      h + "<style>svg{--c:red} @media (prefers-color-scheme: dark){svg{--c:blue}} .a{fill:var(--c)}</style>" + r,
      h + "<style>.a{fill:light-dark(red, blue)}</style>" + r,
    ]
    for (i, s) in cases.enumerated() {
      let l = middle(s, dark: false)
      let d = middle(s, dark: true)
      #expect(l.r > 0.9 && l.b < 0.1, "case \(i) light \(l)")
      #expect(d.b > 0.9 && d.r < 0.1, "case \(i) dark \(d)")
    }
  }
}
