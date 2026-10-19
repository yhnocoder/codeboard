#include "launch.cuh"

namespace deep_ep {

namespace intranode {

template <int kNumRanks, int kNumThreads, int kNumTMABytesPerWarp>
__global__ void __launch_bounds__(kNumThreads, 1)
dispatch(int4* recv_x, int num_tokens) {
    const auto sm_id = static_cast<int>(blockIdx.x);
    if (sm_id < kNumRanks) recv_x[sm_id] = make_int4(0, 0, 0, 0);
}

void dispatch(void* recv_x, int num_tokens, int num_ranks, cudaStream_t stream, int num_sms) {
    constexpr int kNumThreads = 768;
    constexpr int kNumTMABytesPerWarp = 8192;

#define DISPATCH_LAUNCH_CASE(ranks) { \
    auto kernel = dispatch<ranks, kNumThreads, kNumTMABytesPerWarp>; \
    LAUNCH_KERNEL(&cfg, kernel, reinterpret_cast<int4*>(recv_x), num_tokens); \
    } break

    SETUP_LAUNCH_CONFIG(num_sms, kNumThreads, stream);
    SWITCH_RANKS(DISPATCH_LAUNCH_CASE);
#undef DISPATCH_LAUNCH_CASE
}

template <int kBlock>
__global__ void add_kernel(float* out, const float* a, int n) {
    out[0] = a[0] + kBlock;
}

void add(float* out, const float* a, int n, cudaStream_t s) {
    constexpr int kThreads = 256;
    add_kernel<kThreads><<<1, kThreads, 0, s>>>(out, a, n);
}

}  // namespace intranode

}  // namespace deep_ep
