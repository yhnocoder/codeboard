import tilelang
import tilelang.language as T


@tilelang.jit(out_idx=[-1])
def flashmla_decode(heads, block_N=64, num_stages=2):
    blk = 32

    @T.prim_func
    def main(Q: T.Tensor((heads, 64), "float16")):
        with T.Kernel(heads, threads=128) as bx:
            for k in T.Pipelined(4, num_stages=num_stages):
                T.clear(Q)

    return main


def run_mla_decode(q, heads):
    kernel = flashmla_decode(heads, block_N=64, num_stages=2)
    return kernel(q)
