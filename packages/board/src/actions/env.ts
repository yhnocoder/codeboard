// The board's side of core's command layer: the env a command gets is this board's store, host and dialogs
import type { CommandEnv, VersionEnv } from "@codeboard/core/commands";
import { unwrap } from "solid-js/store";
import { state, shared } from "../state/store";
import { putStale, putViews, staleOf, staleOk } from "../state/views";
import { mutate, createFresh, isFresh, settleFresh } from "../state/changes";
import { toast } from "../state/toast";
import { ask } from "../host";
import { choose } from "../ui/Menu";

export const commandEnv: CommandEnv = {
  board: () => unwrap(state.board),
  edit: (fn, opts) => mutate(fn, opts),
  fresh: { add: createFresh, is: isFresh, settle: settleFresh },
  ask,
  choose: ({ title, options, ...o }) => choose(title, options, o),
  toast,
  settings: () => state.host.settings,
  boardsOf: (id) => shared[id]?.boards.map((b) => b.name) ?? [],
};

export const versionEnv: VersionEnv = {
  ...commandEnv,
  stale: staleOf,
  staleOk,
  putViews,
  dropStale: (ids) => putStale(Object.fromEntries(ids.map((id) => [id, undefined]))),
};
