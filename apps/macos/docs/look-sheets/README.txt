Review material for PR #214, to be removed before the PR is ready.

Each PNG is web | native | difference, top aligned, at 2x: the web board (the reference page of
tools/markdown/page, the Markdown package's editor with the board's stylesheets, headless Chromium) and
the Mac app's own Note path (CodeBoardNotes over CodeBoardMarkdownUI, via the MarkdownLook target), each
on the look's paper. Magenta pads the shorter side. One folder per look and appearance.

Notes 360 wide: basics, mixed, code, math, diagram, images, refs (tools/markdown/look/*.md; refs resolve as
tools/markdown/look/refs.json says, code is coloured by the app's highlighter on both sides). Styled cards
(tools/markdown/look/cards.json): text-*, box-*, mark-*, free-*.

Regenerate: npm run build -w @yhnocoder/markdown && node apps/macos/tools/markdown/look.mjs
(output in apps/macos/.build-look/markdown/).
