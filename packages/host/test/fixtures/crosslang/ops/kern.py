import triton
import triton.language as tl


@triton.autotune(
    configs=[
        triton.Config({"BLOCK_M": 64, "BLOCK_N": 128}, num_stages=3, num_warps=4),
        triton.Config({"BLOCK_M": 128, "BLOCK_N": 64}, num_stages=4, num_warps=8),
        triton.Config({"BLOCK_M": 32, "BLOCK_N": 64}, num_stages=5, num_warps=2),
    ],
    key=["N"],
)
@triton.jit
def fused_moe_kernel(a_ptr, c_ptr, N, BLOCK_K: tl.constexpr, BLOCK_M: tl.constexpr, BLOCK_N: tl.constexpr):
    pid = tl.program_id(0)
    tl.store(c_ptr + pid, tl.load(a_ptr + pid))


def invoke_fused_moe_kernel(a, c, n):
    grid = (n,)
    fused_moe_kernel[grid](a, c, n, BLOCK_K=32)
