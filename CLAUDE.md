# CLAUDE.md

Development workflow and architecture rules: @CONTRIBUTING.md

Test tiers, time budgets and commands: @TESTING.md

README.md is the user-facing product page. Keep development notes out of it.

Mac app (`apps/macos`): after each change, run the unit tests it touches and the acceptance scenarios it touches (`node apps/macos/tools/accept/run.mjs <scenarios> --only mac`) and read their one-line results. Make recordings (`--video`) only at the end of a batch, for the scenarios involved, and read the reports before watching them. Turn every problem found into a scenario with expectations (it fails before the fix) before fixing it. Before a step is handed over, do the interaction and look acceptance in TESTING.md ("Mac app 验收"): the pointer moves to what it presses, and a drag or gesture is watched while it happens, not only where it ends.
