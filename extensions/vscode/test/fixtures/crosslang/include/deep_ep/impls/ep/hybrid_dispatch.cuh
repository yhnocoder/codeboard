#pragma once

namespace deep_ep::ep {

template <int kNumSMs, int kNumScaleoutRanks>
__global__ void hybrid_dispatch_impl(void* x) {
    // 跨节点 dispatch
}

}  // namespace deep_ep::ep
