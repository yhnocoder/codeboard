# Native Markdown

调度器把请求分成批次，每个批次在显存里保留==键值缓存==，然后计算注意力 $\operatorname{softmax}(QK^\top / \sqrt{d})V$。

- prefill first
  - then **decode**
- [x] blocks freed
- [ ] swap back

1. one
2. two
   - nested in a number

- loose item

- another loose item
