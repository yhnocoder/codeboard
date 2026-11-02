// The board's Markdown instance (made once by wireBoard) reaches the components that render or edit Markdown through this
// context; the shell provides it around the board (boot.tsx, the stories)
import { createContext, useContext } from "solid-js";
import type { Markdown } from "@yhnocoder/markdown";

export const MdContext = createContext<Markdown>();

export function useMd(): Markdown {
  const md = useContext(MdContext);
  if (!md) throw new Error("No Markdown instance: render the board inside MdContext.Provider (boot, the stories)");
  return md;
}
