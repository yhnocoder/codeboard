template <int kNumRanks, int kNumThreads, int kNumTMABytesPerWarp>
__global__ void __launch_bounds__(kNumThreads, 1)
dispatch(int4* recv_x, int num_tokens) {
}

void dispatch(void* recv_x, int num_tokens, int num_ranks, cudaStream_t stream, int num_sms) {
    constexpr int kNumThreads = 768;
    constexpr int kNumTMABytesPerWarp = 8192;
#define DISPATCH_LAUNCH_CASE(ranks) { \
    auto kernel = dispatch<ranks, kNumThreads, kNumTMABytesPerWarp>; \
    SET_SHARED_MEMORY_FOR_TMA(kernel); \
    LAUNCH_KERNEL(&cfg, kernel, \
        reinterpret_cast<int4*>(recv_x), num_tokens); \
    } break

    SETUP_LAUNCH_CONFIG(num_sms, kNumThreads, stream);
    SWITCH_RANKS(DISPATCH_LAUNCH_CASE);
#undef DISPATCH_LAUNCH_CASE
}
