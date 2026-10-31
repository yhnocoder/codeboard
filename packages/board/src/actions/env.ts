// The board's side of core's command layer: the env a command gets is this board's store, host and dialogs
import type { CommandEnv, VersionEnv } from "@codeboard/core/commands";
import { state, sharedOn } from "../state/store";
import { putViews, staleOk } from "../state/views";
import { mutate } from "../state/changes";
import { toast } from "../state/toast";
import { ask } from "../host";
import { choose } from "../ui/Menu";

const commandEnv: CommandEnv = {
  board: () => state.board,
  edit: (fn) => mutate(fn),
  ask,
  choose: ({ title, options, ...o }) => choose(title, options, o),
  toast,
  settings: () => state.host.settings,
};

export const versionEnv: VersionEnv = {
  ...commandEnv,
  stale: (id) => state.stale[id],
  staleOk,
  putViews,
  sharedOn,
};
