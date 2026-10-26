import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Frames, type Globals } from "./support/board";

const meta = { title: "Overview" } satisfies Meta;
export default meta;

export const All: StoryObj<typeof meta> = {
  render: (_, ctx) => <Frames globals={ctx.globals as Globals} items={[
    { id: "cards-note--overview", title: "Note", h: 960 },
    { id: "cards-code--overview", title: "Code", h: 700 },
    { id: "cards-mark--overview", title: "Mark", h: 620 },
    { id: "toolbar--wide", title: "Toolbar", w: 1100, h: 220 },
  ]} />,
};
