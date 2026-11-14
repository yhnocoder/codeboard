调度流程：

```mermaid
flowchart LR
  A[请求进入] --> B{有空闲块?}
  B -->|是| C[Prefill]
  B -->|否| D[等待队列]
  C --> E[Decode]
  D --> B
```

After the diagram.
