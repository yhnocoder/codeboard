// 图片的 AI 操作还在等模型时：哪张卡在忙（卡上盖一层「Reading image…」、能取消）。剪贴板的 Paste Image Text 没有卡，card 为空；
// ghost = 还没有卡、图画好了放在视口中间（Image ▾ New SVG from Text…）：在那里先摆一张空卡的样子盖着忙碌层
import { boardSignal } from "./root";

export type AiJob = { job: number; card?: string; ghost?: boolean; label: string; cancel: (quiet?: boolean) => void };
export const [aiJobs, setAiJobs] = boardSignal<AiJob[]>([]);
export const aiJobOn = (card: string) => aiJobs().find((j) => j.card === card);
