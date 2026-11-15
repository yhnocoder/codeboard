Python:

```python
@torch.inference_mode()
def step(self, batch: Batch) -> list[int]:
    """Run one step of the batch."""
    logits = self.model(batch.ids, positions=batch.pos)  # forward
    return [int(t) for t in logits.argmax(-1)] + [0x1F, 3.5, "eos"]
```

CUDA:

```cuda
__global__ void scale(float* x, int n, float k) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;  // one thread a value
  if (i < n) x[i] *= k;
}
scale<<<(n + 255) / 256, 256>>>(x, n, 2.0f);
```

Rust and an unknown language:

```rust
fn main() { let v: Vec<u32> = (0..3).collect(); println!("{v:?}"); }
```

```text
plain text, no colours
```
