// The Shelf's view state (actions/shelf.ts; the entries themselves are in the board, Board.shelf): whether its panel is open, what
// a drag over it is aiming at, the outline of an entry being dragged out onto the board, the entry whose thumbnail the pointer
// rests on and the one shown large beside the panel
import { boardSignal } from "./root";

/** The Shelf panel is open (the dock's Shelf button) */
export const [shelfOpen, setShelfOpen] = boardSignal(false);
/**
 * A drag of cards or Sections is on (drag: the dock's Shelf button shows it can take them), over the dock's Shelf button or over
 * the open Shelf panel (dock, panel: letting go puts them on the Shelf)
 */
export const [shelfHot, setShelfHot] = boardSignal<"drag" | "dock" | "panel" | null>(null);
/**
 * An entry being dragged out of the panel: its id, and while the pointer is over the board, where its outline is (world
 * coordinates of the entry's top left; none: over the panel, letting go does nothing)
 */
export const [shelfOut, setShelfOut] = boardSignal<{ id: string; at?: { x: number; y: number } } | null>(null);
/**
 * The entry whose thumbnail the pointer rests on, and the part of the board that is seen past the panel and the toolbars (board
 * px, measured when the pointer came onto it): the board outlines where the entry returns to while that is in view
 */
export const [shelfHover, setShelfHover] = boardSignal<{
  id: string;
  seen: { x: number; y: number; w: number; h: number };
} | null>(null);
/** The entry shown large beside the panel (a click on its thumbnail) */
export const [shelfPeek, setShelfPeek] = boardSignal<string | null>(null);
