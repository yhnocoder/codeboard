#include <ATen/native/mps/OperationUtils.h>

namespace at::native {

static void softmax_mps_impl(const Tensor& input, const Tensor& output) {
  @autoreleasepool {
    MPSGraph* graph = [MPSGraph new];
  }
}

TORCH_IMPL_FUNC(softmax_mps_out)
(const Tensor& input_, const int64_t dim, const bool half_to_float, const Tensor& output) {
  softmax_mps_impl(input_, output);
}

} // namespace at::native
