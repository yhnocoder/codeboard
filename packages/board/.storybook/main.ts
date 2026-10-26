// 小样只是看和调界面的工具：不进 npm run check、CI，也不打进插件包
import type { StorybookConfig } from "storybook-solidjs-vite";

const config: StorybookConfig = {
  // docgen 关掉：它会把白板的每个 .tsx 都过一遍 TypeScript；controls 在各个 story 里手写
  // 不用 packages/board/vite.config.ts：它的 build 写的是插件的输出目录和入口
  framework: { name: "storybook-solidjs-vite", options: { docgen: false, builder: { viteConfigPath: ".storybook/vite.config.ts" } } },
  stories: ["../stories/**/*.stories.tsx"],
  staticDirs: [{ from: "../stories/fixtures/assets", to: "/sb-assets" }],
  core: { disableTelemetry: true },
};
export default config;
