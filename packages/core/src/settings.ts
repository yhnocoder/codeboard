// CodeBoard 的设置只在这里声明一次：设置名（codeboard.<key>）、宿主收下白板改的值前怎么检查、编辑器设置页里的说明（JSON Schema）。
// VS Code 插件的 package.json（contributes.configuration）由它生成（extensions/vscode/src/contributes.ts），宿主读写设置也按它（host/settings.ts）。
// 白板不引入这个文件
import {
  DEFAULT_SETTINGS,
  EXPERIMENTAL_THEMES,
  HIGHLIGHT_LOOKS,
  HIGHLIGHT_LOOK_NAMES,
  NOTE_FONT_LEVELS,
  NOTE_FONT_RANGE,
  THEMES,
  type Settings,
} from "./protocol";

/** One setting as an editor's settings page describes it: a JSON Schema subset, with the enumDescriptions, markdownDescription and editPresentation a settings page may show */
export type SettingSchema = {
  type: "string" | "boolean" | "number" | "object" | "array" | ("number" | "null")[];
  default?: unknown;
  enum?: readonly string[];
  enumDescriptions?: readonly string[];
  description?: string;
  markdownDescription?: string;
  minimum?: number;
  maximum?: number;
  items?: SettingSchema;
  properties?: Record<string, SettingSchema>;
  additionalProperties?: boolean;
  editPresentation?: "multilineText";
};

/** 白板也读写的一项设置：key = codeboard. 后面的名字；valid = 白板发来的值能不能写进设置；schema 不写 default 时取 DEFAULT_SETTINGS 的 */
export type SettingDecl = { key: string; valid: (v: unknown) => boolean; schema: SettingSchema };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const bool = (v: unknown) => typeof v === "boolean";
const str = (v: unknown) => typeof v === "string";
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const oneOf =
  (...xs: string[]) =>
  (v: unknown) =>
    xs.includes(v as string);
const aiChoice = (v: unknown) => typeof v === "string" && !!v.trim() && v.length <= 200;
function fontPx(level: string, v: unknown) {
  const [lo, hi] = NOTE_FONT_RANGE[level === "body" ? "body" : "heading"];
  return num(v) && (v as number) >= lo && (v as number) <= hi;
}
/** 一个枚举设置：值和设置页里的说明一一对应 */
const choices = (pairs: [string, string][]) => ({
  enum: pairs.map(([v]) => v),
  enumDescriptions: pairs.map(([, d]) => d),
});

const AI_CHOICE_TAIL =
  "`auto` (DeepSeek if an API key is set, otherwise a language model the editor provides, such as GitHub Copilot), `deepseek`, or the id of one of the editor's language models. Pick it in CodeBoard Settings › AI, which lists the models you have.";
const fontLevel = (name: string, [lo, hi]: readonly [number, number]): SettingSchema => ({
  type: ["number", "null"],
  minimum: lo,
  maximum: hi,
  description: `${name} size in px. Leave out or null to use the theme's size.`,
});

export const SETTINGS: { [K in keyof Settings]-?: SettingDecl } = {
  aiProvider: {
    key: "ai.provider",
    valid: oneOf("auto", "copilot", "deepseek", "off"),
    schema: {
      type: "string",
      ...choices([
        ["auto", "DeepSeek if an API key is set, otherwise a language model the editor provides, such as Copilot."],
        ["copilot", "A language model the editor provides (for example GitHub Copilot)."],
        ["deepseek", 'DeepSeek. Set the key with "CodeBoard: Set DeepSeek API Key".'],
        ["off", "No gray inline completions."],
      ]),
      markdownDescription:
        "Model for the gray inline completions while you write a Note. The DeepSeek API key is kept in the editor's secret storage: use **CodeBoard: Set DeepSeek API Key**.",
    },
  },
  deepseekModel: {
    key: "ai.deepseekModel",
    valid: (v) => typeof v === "string" && v.length <= 200,
    schema: {
      type: "string",
      description:
        "DeepSeek model for inline completions and the AI tools (Extract Text, Convert to SVG, Modify SVG, Draw as SVG, Paste Image Text, Auto Focus). The image tools need a model that reads images.",
    },
  },
  svgNoBg: {
    key: "ai.svg.removeBackground",
    valid: bool,
    schema: {
      type: "boolean",
      description:
        "Convert to SVG draws no background (the paper color of the image becomes transparent). Also set from the check item under Convert to SVG in an image's context menu.",
    },
  },
  svgThink: {
    key: "ai.svg.thinkFirst",
    valid: bool,
    schema: {
      type: "boolean",
      description:
        "Convert to SVG lets the model think before it draws: several times slower, with a more accurate layout. Also set from the check item under Convert to SVG in an image's context menu.",
    },
  },
  aiText: {
    key: "ai.textModel",
    valid: aiChoice,
    schema: {
      type: "string",
      markdownDescription: `Model for reading text from images (Extract Text, Paste Image Text): ${AI_CHOICE_TAIL}`,
    },
  },
  aiSvg: {
    key: "ai.svgModel",
    valid: aiChoice,
    schema: {
      type: "string",
      markdownDescription: `Model for Convert to SVG, Modify SVG and Draw as SVG: ${AI_CHOICE_TAIL} Think First applies to DeepSeek only.`,
    },
  },
  aiFocus: {
    key: "ai.focusModel",
    valid: aiChoice,
    schema: {
      type: "string",
      markdownDescription: `Model for Auto Focus (highlights the key concepts and bolds what matters in a Note): ${AI_CHOICE_TAIL}`,
    },
  },
  theme: {
    key: "theme",
    valid: (v) => THEMES.some(([id]) => id === v),
    schema: {
      type: "string",
      ...choices(THEMES.map(([id, name]) => [id, EXPERIMENTAL_THEMES.includes(id) ? `${name} (Experimental)` : name])),
      description:
        "Board theme. Each theme has a light and a dark variant that follows the editor's color theme. City is experimental.",
    },
  },
  hideOnNew: {
    key: "newCards.hide",
    valid: (v) => isObj(v) && Object.values(v).every((x) => x === undefined || typeof x === "boolean"),
    schema: {
      type: "object",
      properties: { comments: { type: "boolean" }, docstrings: { type: "boolean" }, blank: { type: "boolean" } },
      description: "What new code cards hide by default.",
    },
  },
  studyScope: {
    key: "studyScope",
    valid: (v) => Array.isArray(v) && v.every(str),
    schema: {
      type: "array",
      items: { type: "string" },
      description: "Packages outside the workspace that count as project code (e.g. torch, vllm).",
    },
  },
  stickerDir: {
    key: "stickerFolder",
    valid: str,
    schema: {
      type: "string",
      description:
        "Folder with sticker packs (Iconify JSON files, or folders of SVG, PNG, WebP or GIF images; animated ones play).",
    },
  },
  debug: {
    key: "debug.enabled",
    valid: bool,
    schema: {
      type: "boolean",
      description: "Show a Debug section in CodeBoard Settings for tuning timings and distances.",
    },
  },
  tune: {
    key: "debug.tune",
    valid: (v) => isObj(v) && Object.values(v).every(num),
    schema: { type: "object", description: "Tuned constants from the Debug section (empty = defaults)." },
  },
  dblClick: {
    key: "doubleClick",
    valid: oneOf("text", "note", "code", "none"),
    schema: {
      type: "string",
      ...choices([
        ["text", "Text"],
        ["note", "Note"],
        ["code", "Free Code card"],
        ["none", "Nothing"],
      ]),
      description: "What double-clicking empty board space creates.",
    },
  },
  noteHeadingInBody: {
    key: "notes.headingInBody",
    valid: bool,
    schema: {
      type: "boolean",
      description:
        "When a Note starts with a heading, the card's title bar shows it. Also show it at the top of the Note's text (it always shows while editing).",
    },
  },
  highlightLook: {
    key: "highlights.look",
    valid: oneOf(...HIGHLIGHT_LOOKS),
    schema: {
      type: "string",
      ...choices(
        HIGHLIGHT_LOOKS.map((v): [string, string] => [
          v,
          `${HIGHLIGHT_LOOK_NAMES[v]}: ${
            {
              band: "the lines and their Always Show notes are one soft band",
              bracket: "a pen bracket beside the lines, notes as margin notes in the Note font",
              "bracket-hand": "the bracket, with the notes in handwriting",
            }[v]
          }`,
        ]),
      ),
      description:
        "Highlight look: how code cards draw Highlights (highlighted lines) and the notes on them. A Highlight never changes a card's size.",
    },
  },
  mathPreamble: {
    key: "math.preamble",
    valid: str,
    schema: {
      type: "string",
      editPresentation: "multilineText",
      markdownDescription:
        "Math preamble: `\\newcommand` and `\\def` lines that every formula on the boards can use, for example `\\newcommand{\\R}{\\mathbb{R}}`. The board's Settings page saves it in the workspace (this project); a user-level value applies to projects without their own. Applies right away to Notes, the editor and exports.",
    },
  },
  noteFontSize: {
    key: "notes.fontSize",
    valid: (v) =>
      isObj(v) &&
      Object.entries(v).every(
        ([k, x]) => NOTE_FONT_LEVELS.includes(k as never) && (x === null || x === undefined || fontPx(k, x)),
      ),
    schema: {
      type: "object",
      default: {},
      additionalProperties: false,
      properties: Object.fromEntries(
        NOTE_FONT_LEVELS.map((l) => [
          l,
          l === "body"
            ? fontLevel("Body text", NOTE_FONT_RANGE.body)
            : fontLevel(`Heading ${l.slice(1)}`, NOTE_FONT_RANGE.heading),
        ]),
      ),
      description:
        "Font sizes in Notes, in px: body text and each heading level. Levels left out follow the theme (headings scale with the body text). Text cards keep their own sizes.",
    },
  },
  hideNumbers: {
    key: "flowNumbers.hide",
    valid: bool,
    schema: { type: "boolean", description: "Hide the call graph marks (A, B… or an icon) on cards." },
  },
  vscodeBg: {
    key: "useVSCodeBackground",
    valid: bool,
    schema: {
      type: "boolean",
      description:
        "Use the editor's background as the board background in every theme. Cards, text and accent colors stay the theme's; patterns such as grids stay on top.",
    },
  },
  simpleBelow: {
    key: "zoom.simplifyBelow",
    valid: (v) => num(v) && (v as number) >= 0 && (v as number) <= 0.9,
    schema: {
      type: "number",
      minimum: 0,
      maximum: 0.9,
      description:
        "Zoomed out below this scale (0.5 = 50 %), with the cards still shown, Notes' text is drawn as light bars, and the lines and blocks inside cards do not react to the pointer: links start only from card edges. Zooming there stays smooth on boards of dense Notes. 0 turns it off.",
    },
  },
  // not "theme.reflow": codeboard.theme is a string, so VS Code ignores keys under it
  themeReflow: {
    key: "themeReflow",
    valid: oneOf("push", "overlap"),
    schema: {
      type: "string",
      ...choices([
        ["push", "Push cards below down"],
        ["overlap", "Allow overlap"],
      ]),
      description: "When switching themes makes cards taller: push the cards below them down, or let them overlap.",
    },
  },
  pasteOther: {
    key: "sharedCards.paste",
    valid: oneOf("linked", "copy"),
    schema: {
      type: "string",
      ...choices([
        ["linked", "Linked card: the same card on both boards, content stays in sync"],
        ["copy", "Copy: a new card that changes on its own"],
      ]),
      description:
        "What pasting a card onto another board makes. Holding Alt (Option) while pasting makes the other one.",
    },
  },
  sharedUpdate: {
    key: "sharedCards.update",
    valid: oneOf("ask", "all", "this"),
    schema: {
      type: "string",
      ...choices([
        ["ask", "Ask every time"],
        ["all", "Update on all boards"],
        ["this", "Update this board only (makes a copy here)"],
      ]),
      description: "When updating a card that is on several boards to a new version.",
    },
  },
  subPreview: {
    key: "subBoards.preview",
    valid: oneOf("skeleton", "title"),
    schema: {
      type: "string",
      ...choices([
        ["skeleton", "Named skeleton: card titles, call graph marks and arrows of the board inside"],
        ["title", "Title only: the board's name and card count"],
      ]),
      description: "What a sub-board frame shows on its parent board.",
    },
  },
  welcomeBack: {
    key: "questions.welcomeBack",
    valid: oneOf("2d", "always", "off"),
    schema: {
      type: "string",
      ...choices([
        ["2d", "When the board was last opened more than 2 days ago"],
        ["always", "Every time a board with open questions opens"],
        ["off", "Never"],
      ]),
      description: "When reopening a board, show how many questions on it are still open.",
    },
  },
  exportQuestions: {
    key: "export.includeQuestions",
    valid: bool,
    schema: { type: "boolean", description: "Include questions (? stickers) in HTML and Markdown exports by default." },
  },
  exportBoardOnly: {
    key: "export.includeBoardOnlyNotes",
    valid: bool,
    schema: {
      type: "boolean",
      description: "Include Board-only sidenotes (private notes on linked cards) in exports by default.",
    },
  },
  exportScope: {
    key: "export.scope",
    valid: oneOf("board", "sections", "walk"),
    schema: {
      type: "string",
      ...choices([
        ["board", "Whole board"],
        ["sections", "Selected sections"],
        ["walk", "One walkthrough path (from the Start card or the selected card)"],
      ]),
      description: "What the Export dialog exports by default.",
    },
  },
};

/** Settings only the host reads (the board neither reads nor changes them): key = the name after codeboard. */
export const HOST_SETTINGS = {
  deepseekBaseUrl: {
    key: "ai.deepseekBaseUrl",
    schema: { type: "string", default: "https://api.deepseek.com", description: "DeepSeek API base URL." },
  },
  searchEmbeddingUrl: {
    key: "search.embeddingUrl",
    schema: {
      type: "string",
      default: "",
      markdownDescription:
        "OpenAI-compatible embedding server for Search › Related by Meaning, running on your own machine, e.g. `http://127.0.0.1:11001/v1` (oMLX serving EmbeddingGemma). Empty: off. Set its key with **CodeBoard: Set Embedding API Key**. The index is kept in your user data folder (`codeboard-box/`, shared by every window), not in the project.",
    },
  },
  searchEmbeddingModel: {
    key: "search.embeddingModel",
    schema: {
      type: "string",
      default: "",
      description: 'Embedding model name on that server. Empty: the first model whose name has "embed".',
    },
  },
  searchRerank: {
    key: "search.rerank",
    schema: {
      type: "boolean",
      default: true,
      markdownDescription:
        "Read the best results of Search › Related by Meaning again with a reranking model on the embedding server (`POST /rerank`; e.g. hs-rerank-1 loaded in oMLX) and reorder them when it answers. Needs a reranking model on that server (see `#codeboard.search.rerankModel#`): without one the order stays by meaning, and after you turn this on CodeBoard says so (once, at the next search). Off: the order by meaning alone.",
    },
  },
  searchRerankWait: {
    key: "search.rerankWait",
    schema: {
      type: "boolean",
      default: true,
      markdownDescription:
        "Show Search › Related by Meaning only once the reranker has answered, already in its order. Off: the order by meaning comes first and the rows slide to the reranker's order when it answers. Only while `#codeboard.search.rerank#` is on.",
    },
  },
  searchRerankModel: {
    key: "search.rerankModel",
    schema: {
      type: "string",
      default: "",
      description: 'Reranking model name on the embedding server. Empty: the first model whose name has "rerank".',
    },
  },
  storageDir: {
    key: "storageDir",
    schema: {
      type: "string",
      default: "",
      markdownDescription:
        "Folder for board files. Leave empty to use the `.codeboard` folder in the first workspace folder when there is one (see **Move Boards into Project…**), otherwise the editor's workspace storage (outside the repo). Absolute, `~/…`, or relative to the first workspace folder, e.g. `~/notes/codeboard`.",
    },
  },
} satisfies Record<string, { key: string; schema: SettingSchema }>;
export type HostSetting = keyof typeof HOST_SETTINGS;

/** 所有设置的完整名字（codeboard.…）→ 说明，default 填好 */
export function settingsSchema(): Record<string, SettingSchema> {
  const out: Record<string, SettingSchema> = {};
  for (const [k, d] of Object.entries(SETTINGS) as [keyof Settings, SettingDecl][]) {
    const { type, ...rest } = d.schema;
    out[`codeboard.${d.key}`] = { type, default: DEFAULT_SETTINGS[k], ...rest };
  }
  for (const d of Object.values(HOST_SETTINGS)) out[`codeboard.${d.key}`] = d.schema;
  return out;
}
