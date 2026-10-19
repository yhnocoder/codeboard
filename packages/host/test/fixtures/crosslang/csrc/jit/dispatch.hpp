#pragma once
#include <format>

namespace deep_ep {

torch::Tensor Buffer::jit_dispatch(const torch::Tensor& x) {
    launch_dispatch(x.size(0), 1, 20);
    return x;
}

static void launch_dispatch(int num_tokens, int num_scaleout_ranks, int num_sms) {
    std::string header_name, func_name;
    if (num_scaleout_ranks == 1) {
        header_name = "dispatch";
        func_name = std::format("dispatch_impl<{}, {}>",
            num_sms, num_tokens);
    } else {
        header_name = "hybrid_dispatch";
        func_name = std::format("hybrid_dispatch_impl<{}, {}>",
            num_sms, num_scaleout_ranks);
    }
    const auto kernel = jit->compile("dispatch", std::format(R"(
#include <deep_ep/impls/ep/{}.cuh>

static void __instantiate_kernel() {{
    auto ptr = reinterpret_cast<void*>(&deep_ep::ep::{});
}}
)", header_name, func_name));
    jit->launch(kernel, num_tokens);
}

}  // namespace deep_ep
