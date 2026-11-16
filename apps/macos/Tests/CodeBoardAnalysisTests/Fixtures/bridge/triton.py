import triton
import triton.language as tl

@triton.autotune(
    configs=[
        triton.Config({"BLOCK_M": 64, "BLOCK_N": 128}, num_stages=3, num_warps=4),
        triton.Config({"BLOCK_M": 128, "BLOCK_N": 64}, num_stages=4, num_warps=8),
    ],
    key=["N"],
)
@triton.jit
def fused_kernel(a_ptr, N, group_n: tl.constexpr, BLOCK_K: tl.constexpr, BLOCK_M: tl.constexpr, BLOCK_N: tl.constexpr):
    pid = tl.program_id(0)


def launch(a, n):
    grid = (n,)
    fused_kernel[grid](a, n, 0, BLOCK_K=32)
