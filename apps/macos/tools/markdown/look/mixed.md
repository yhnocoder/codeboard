## 调度 Scheduler

调度器把请求分成批次，**每个批次**在显存里保留 ==键值缓存==，然后调用 `Scheduler.step()` 计算注意力。The scheduler splits requests into *batches* so that throughput stays high; see [the design notes](https://example.com/a/long/url/to/the/notes) and [[Block manager]].

- prefill 一次处理整段提示
  - nested **bold** item
    - third level
- decode 每步只生成一个 token :rocket:

1. first
   1. sub one
   2. sub two
2. second

> 引用里的 `code` 和 *斜体*
>
> second paragraph in the quote

| 阶段 Stage | 做什么 What it does, in a cell long enough to wrap onto more lines | 耗时 |
|:---|---|--:|
| prefill | 一次处理整段提示，==所有 token== 并行计算 | 12.5 ms |
| decode | 每步生成一个 token, see [notes](https://example.com/decode) | 0.8 |

Table: 两个阶段 the two stages

H~2~O and x^2^ and <u>underlined</u> and <span>inline html</span> and a line<br>break.

<div>
an html block
</div>

[^1]: 词

    indented code
    second line
