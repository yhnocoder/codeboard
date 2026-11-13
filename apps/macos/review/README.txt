Review material for PR #221, removed before the PR is ready. Made-up content only.

textbox/: Texts and Boxes as the Mac canvas shows them at rest (the Note page's picture over the canvas's paper), drawn by
`swift run -c release LookCompare --texts <out>` at 2x and scaled to 1x. Rows: a Text, then a Box in each fill (yellow,
paper, blue, green, pink). Columns: 14, 20, 30 and 48 px as wide as the text, then 16 and 24 px wrapped at 220 and 300.
One sheet per theme and appearance; the Ink Wash sheets are cut into three bands (-1 top, -3 bottom) to keep each file
small, as its backdrop makes them heavy.

stage2/: the canvas while editing a board of made-up content, drawn off screen by Core Animation at 1x with
`swift run LookCompare --edit <out>`, in each theme light and dark (<state>-<theme>[-dark].png):
- selection: two Notes, a Box, an image and a Section selected (Warm Ink: the accent ring; Ink Wash: the vermilion seal
  on cards, the ring on Texts and Boxes, the Section's brush in vermilion)
- drag: Prefill dragged halfway into the Section, over the cards it passes, its arrows routed again as it goes
- handles: each kind selected alone (Note, Text, Box, image, Section), cut out side by side
- marquee: the rubber band halfway, what it touches selected as it goes
- menu: the context menus' items as the canvas builds them for one card (Arrange open), two cards and a Section; macOS
  draws the real menu, which cannot be drawn off screen

stage3/: Notes, Texts and Boxes written in, drawn off screen at 2x with `swift run -c release LookCompare --writing
<out>`, in each theme light and dark (<sheet>-<theme>[-dark].png); report.txt has the counts:
- writing: each card (a Note, a Text as wide as its text, a Text that wraps, a Box) at rest | while written in (the
  paper the canvas shows then, with the editor's own picture of the text) | the pixels that differ in magenta. 0 differ
  in all 16. The editor's picture has no caret. The texts end in words: entering puts the caret at the end, as on the
  web board, and a formula under the caret opens its source there, as on the web board
- bar: the bar over a Text at S, M, L, XL and at 27 px (none lit), and over a Box with each fill chosen
- switch: a Text that wraps | the Box it became | both at half strength (the first line, size and line breaks stay; a
  Box centres its lines)
- scale: a Text | its corner dragged out, during | let go (24 px → 38 px)
- wrap: a Text as wide as its text | its right side dragged in: it wraps there
- refs: [[ typed at the end of the Note: the list under the caret, this board's titled cards first, then another board
  (内存模型 Memory) as a group with its cards and the Section one is in; the count line under it. The list's glass lies
  over the board's backdrop (the web view cannot blur the canvas under it)
