Try-out fixes, recorded with the interaction driver (Sources/Drive: swift run Drive <scenario> <folder>).
Each folder: before-* recorded with the fix reverted, after-* with it; *-report.txt is the driver's verdict.
Raw recordings (every frame) stay outside the repository.

1-toolbar     the bottom toolbar drawn as an empty pill in a window (Warm Ink): the tools were a sublayer of the
              view, under the glass. Before: the pill empty in every frame (the display went to sleep after frame
              125, so the before strip stops there). After: the tools in all 318 frames.
note-fade     found by the driver on the way: when a board opens, a Note's first picture crossfaded with its paper,
              and for one frame the whole card, header too, was half transparent (before-f0008). After: the paper
              stays under the picture until it is whole.
