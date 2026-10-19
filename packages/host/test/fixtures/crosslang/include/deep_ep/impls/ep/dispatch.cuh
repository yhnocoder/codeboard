#pragma once

namespace deep_ep::ep {

template <int kNumSMs, int kNumTokens>
__global__ void dispatch_impl(void* x) {
    // 直连 dispatch
}

}  // namespace deep_ep::ep
