// From GitHub…（ui/GitHubPicker.tsx）：数据都是宿主走 GitHub API 拿的（ask "gh"），这里由假宿主按 op 回。
// repo = 打开时预填的（侧栏 Add Repo…、贴链接时宿主带过来）；预填了就直接打开，链接里带路径和行号就一路打开到那几行
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { GhQuery } from "@codeboard/core";
import { Stage, scene, noteCard, type Globals, type Scene } from "./support/board";
import { HANG } from "./support/host";
import { settled, el, type, click, frames } from "./support/play";
import { SHORT } from "./support/groups";
import { toolbar, menu, menuItem, github } from "./support/ui";
import { setGhPicker } from "../src/state/web";

type Op = GhQuery["op"] | "";
type Args = { repo: string; isPrivate: boolean; truncated: boolean; failAt: Op; error: string; waitAt: Op };

const LINK = "https://github.com/GeeeekExplorer/nano-vllm/blob/main/nanovllm/engine/scheduler.py#L30-L41";
const NOT_FOUND =
  "Repo GeeeekExplorer/nano-vllm-private not found (or private: sign in to GitHub in VS Code to read it).";
const RATE = "GitHub API rate limit reached. Sign in to GitHub in VS Code to raise it.";

function board(): Scene {
  const { board, put } = scene("KV cache 调度");
  put(noteCard("n1", SHORT), { x: 40, y: 40, w: 300 });
  return { board };
}

const ops: Op[] = ["", "repo", "commit", "tree", "file", "card"];
const meta = {
  title: "UI/GitHub Picker",
  render: (a, ctx) => (
    <Stage
      scene={board}
      globals={ctx.globals as Globals}
      replies={{
        gh: (m) =>
          a.waitAt === "card" && m.q.op === "card"
            ? HANG
            : github({
                repo: { private: a.isPrivate },
                truncated: a.truncated,
                fail: a.failAt ? { op: a.failAt, error: a.error } : undefined,
                hang: a.waitAt || undefined,
              })(m),
      }}
    />
  ),
  args: { repo: LINK, isPrivate: false, truncated: false, failAt: "", error: NOT_FOUND, waitAt: "" },
  argTypes: {
    repo: {
      control: "text",
      description: "Prefilled: owner/repo, or a GitHub link (with a path and #L lines it opens to them)",
    },
    isPrivate: { control: "boolean", description: "Private repo (badge)" },
    truncated: { control: "boolean", description: "The file tree is too large and was cut" },
    failAt: { control: "select", options: ops, description: "Which request fails (empty: none)" },
    error: { control: "text", description: "The host's error message" },
    waitAt: { control: "select", options: ops, description: "Which request never answers (shows the loading line)" },
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

const open = async ({ args: a }: { args: Args }) => {
  await settled();
  setGhPicker({ repo: a.repo || undefined });
  await el(".ghp");
};
const loaded = async (c: { args: Args }) => {
  await open(c);
  await el(".ghp-tree .gt");
  await frames(2);
};

/** 打开到文件、选了几行：仓库、分支、钉住的 commit、文件树、代码、底栏 */
export const Overview: Story = {
  play: async (c) => {
    await loaded(c);
    await el(".ghp-code .gl.on");
  },
};
export const Start: Story = { name: "Nothing Opened Yet", args: { repo: "" }, play: open };
export const BadInput: Story = {
  name: "Not a Repo",
  args: { repo: "" },
  play: async (c) => {
    await open(c);
    await type(".ghp-in", "nano vllm");
    await click(".ghp-top .btn");
  },
};
export const Opening: Story = {
  name: "Loading · Opening the Repo",
  args: { repo: "GeeeekExplorer/nano-vllm", waitAt: "repo" },
  play: open,
};
export const LoadingFiles: Story = {
  name: "Loading · Files",
  args: { repo: "GeeeekExplorer/nano-vllm", waitAt: "tree" },
  play: open,
};
export const SignIn: Story = {
  name: "Error · Not Found or Private (Sign In)",
  args: { repo: "GeeeekExplorer/nano-vllm-private", failAt: "repo" },
  play: open,
};
export const RateLimit: Story = {
  name: "Error · Rate Limit",
  args: { repo: "GeeeekExplorer/nano-vllm", failAt: "repo", error: RATE },
  play: open,
};
export const FileError: Story = {
  name: "Error · Opening a File",
  args: { failAt: "file", error: "GitHub: 502 Bad Gateway" },
  play: open,
};
export const RepoOpened: Story = {
  name: "Repo Opened · No File Yet",
  args: { repo: "GeeeekExplorer/nano-vllm" },
  play: loaded,
};
export const Private: Story = {
  name: "Private Repo",
  args: { repo: "GeeeekExplorer/nano-vllm", isPrivate: true },
  play: loaded,
};
export const Tree: Story = {
  name: "Folders Expanded",
  args: { repo: "GeeeekExplorer/nano-vllm" },
  play: async (c) => {
    await loaded(c);
    await click(".ghp-tree .gt.dir");
    await frames(2);
    for (const b of document.querySelectorAll<HTMLElement>(".ghp-tree .gt.dir"))
      if (b.textContent?.includes("engine")) b.click();
  },
};
export const Filter: Story = {
  name: "Go to File",
  play: async (c) => {
    await loaded(c);
    await type(".ghp-filter", "py");
  },
};
export const FilterNone: Story = {
  name: "Go to File · No Match",
  play: async (c) => {
    await loaded(c);
    await type(".ghp-filter", "cuda_graph.cu");
  },
};
export const Truncated: Story = {
  name: "Large Repo (Tree Cut)",
  args: { repo: "GeeeekExplorer/nano-vllm", truncated: true },
  play: loaded,
};
// 下拉按输入框里的字筛：清空后列出全部分支
export const BranchList: Story = {
  name: "Branch List Open",
  play: async (c) => {
    await loaded(c);
    await type(".ghp-refin", "");
  },
};
export const BranchFiltered: Story = {
  name: "Branch List · Filtered",
  play: async (c) => {
    await loaded(c);
    await type(".ghp-refin", "fix");
  },
};
export const Tag: Story = {
  name: "Tag Mode",
  play: async (c) => {
    await loaded(c);
    for (const b of document.querySelectorAll<HTMLElement>(".ghp-seg button")) if (b.textContent === "Tag") b.click();
    await el(".ghp-tree .gt");
  },
};
export const Commit: Story = {
  name: "Commit Mode",
  play: async (c) => {
    await loaded(c);
    for (const b of document.querySelectorAll<HTMLElement>(".ghp-seg button"))
      if (b.textContent === "Commit") b.click();
  },
};
export const NoTags: Story = {
  name: "No Tags (Tag Disabled)",
  args: { repo: "GeeeekExplorer/nano-vllm" },
  play: loaded,
  render: (a, ctx) => (
    <Stage
      scene={board}
      globals={ctx.globals as Globals}
      replies={{ gh: github({ repo: { tags: [], private: a.isPrivate } }) }}
    />
  ),
};
export const Adding: Story = {
  name: "Adding…",
  args: { waitAt: "card" },
  play: async (c) => {
    await loaded(c);
    await el(".ghp-code .gl.on");
    await click(".ghp-foot .btn.pri");
  },
};
export const FromToolbar: Story = {
  name: "From the Toolbar",
  args: { repo: "" },
  play: async () => {
    await settled();
    await toolbar("Code");
    await menu();
    await menuItem("From GitHub…");
  },
};
