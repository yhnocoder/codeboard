import tilelang
import tilelang.language as T

@tilelang.jit(out_idx=[-1])
def flashmla_decode(h, block_N=64, num_stages=2):
    blk = 32

    @T.prim_func
    def main(Q: T.Tensor):
        with T.Kernel(1) as bx:
            pass

    return main


def run(q):
    kernel = flashmla_decode(16, block_N=128, num_stages=2)
    return kernel(q)
