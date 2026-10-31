// The board's command layer: rules that act on a board and its input, reaching the host, the user and the store only
// through CommandEnv. The board wires the env to its Solid store, host messages and dialogs; another shell to its own.
// Not the editor commands of packages/host/src/commands.ts: these are what a board button or key does.
import type { Board } from "../model";
import type { AskType, BoardToHost, ReplyOf, Settings } from "../protocol";

/** The body of a request to the host, without the request id */
export type AskBody<T extends AskType> = Omit<Extract<BoardToHost, { type: T }>, "req" | "type">;

/** A question for the user: one button per option. text = a line under the title, warn = a warning line, note = a footnote */
export type Choice = { title: string; options: string[]; text?: string; warn?: string; note?: string };

export interface CommandEnv {
  /** The board as it is now. Read only: change it through edit */
  board(): Board;
  /** A user edit: one undo step */
  edit(fn: (b: Board) => void): void;
  /** A request to the host; the reply's type is ReplyOf */
  ask<T extends AskType>(type: T, body: AskBody<T>): Promise<ReplyOf<T>>;
  /** Ask the user; the option's index, or null when the question was dismissed */
  choose(q: Choice): Promise<number | null>;
  toast(text: string): void;
  settings(): Settings;
}
