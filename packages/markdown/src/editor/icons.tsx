// 工具条图标：路径表在 ../ui/icons.ts（tools/icons/gen.mjs 生成）
import { iconPath, type IconName } from "../ui/icons";

export type { IconName };

export const Icon = (p: { name: IconName }) => (
  <svg class="md-ico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d={iconPath(p.name)} />
  </svg>
);
