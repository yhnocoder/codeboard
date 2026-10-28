#include <ATen/core/Tensor.h>

namespace at::native {

TORCH_IMPL_FUNC(softmax_cuda_out) (const Tensor &input, const int64_t dim, const bool half_to_float, const Tensor &output) {
  host_softmax(input, dim, half_to_float, output);
}

} // namespace at::native
