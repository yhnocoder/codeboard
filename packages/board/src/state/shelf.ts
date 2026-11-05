// The Shelf's view state (actions/shelf.ts; the entries themselves are in the board, Board.shelf): whether its panel is open, what
// a drag over it is aiming at, and the outline of an entry being dragged out onto the board
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
