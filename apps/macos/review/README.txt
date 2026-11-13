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
