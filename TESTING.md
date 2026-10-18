# 测试规则

三层，各有时间上限。可以漏掉小问题，但大问题和正在修的问题每一层都一定会测到。

| 层 | 什么时候 | 时间上限 | 跑什么 |
|---|---|---|---|
| 1 本地 | 每次改完：`npm run check` | 3 分钟 | typecheck、单元测试、host 测试；这次改动需要的 harness 场景 |
| 2 CI | 每次 push、每个 PR（`ci.yml`） | 5 分钟 | 第 1 层的全部；harness 两个 job 并行；e2e 拆两段并行；perf（只在改了被测代码时跑） |
| 3 每晚 | 北京时间 02:30（`nightly.yml`），03:00 replay（`replay.yml`） | 不限 | 全部 harness 场景、整套 e2e（包括平时不跑的 export / variants / codeedit）、完整 perf、study-task replay |

## 一定会测到的

**大问题**：typecheck、单元测试、host 测试、e2e 主流程每次都跑。`packages/board/test/tiers.json` 里的 `smoke` 列表也每次都跑，每个主要功能一个跑得快的场景。

**正在修的问题**：下面这几类场景不受时间预算限制，每次都跑：
- 这次改动新增或改过的测试文件里的场景
- 昨晚还没有的新场景
- 昨晚全量跑挂了的场景（会一直跑，直到修好）
- 点名要跑的：本地 `npm run check -- 场景名 …`；PR 描述里写一行 `Tests: 场景名, 场景名`

**其余的**按"改到的源文件"挑：每晚全量跑时会记下每个场景执行到了哪些源文件，以及跑了多久（覆盖率，存在 `ci-screenshots` 分支的 `impact/`）。挑的时候和这次改动最相关的排在前面，直到用完预算；放不下的写进 CI 报告，标成"留给夜里全量"。CSS、构建配置、lockfile、harness 自己这类改动看不出影响哪些场景，就当所有场景都可能受影响，先跑快的。

## 怎么算失败

harness 场景里打印出以 `FAIL` 开头的一行、抛异常、或者退出码不是 0，都算失败，CI 会变红。

几个进程一起跑时挂了的场景会单独再跑一次，单独跑过了就算过（报告里标"alone"）。对 CPU 负载敏感、并行时必挂的场景登记在 `tiers.json` 的 `solo`，等别的都跑完再单独跑（和 perf 一样）。

`tiers.json` 的 `known` 里登记的是已知、另有地方跟进的失败。它们照样会出现在报告里，但不让 CI 变红。修好时把那一条删掉。

## 常用命令

```bash
npm run check                         # 本地第 1 层，约 3 分钟
npm run check -- markdownRender notes          # 加上点名的场景
npm run check -- --all                # 所有场景，不限时间
node packages/board/test/run-harness.mjs markdownRender            # 只跑一个场景（输出直接打出来）
node packages/board/test/run-harness.mjs --workers=4      # 所有场景，4 个进程一起跑
npm run e2e                                               # 整套 e2e（E2E_PART=1|2|3 或 E2E_ONLY=capture,addsel 只跑一部分）
```

## 加新测试时

- 新场景写在 `packages/board/test/` 的某个文件里，在 `scenarios.ts` 的 `GROUPS` 里登记这个文件（同一个文件里加场景不用改）。
- 一个场景单独跑最好在 20 秒以内；更长的，考虑拆开。
- 只记录、不判对错的场景放进 `tiers.json` 的 `manual`，默认不跑。
- 改了很基础的东西（store、渲染）又想在本地多跑一些：`npm run check -- --all`。
