#include <ATen/core/Tensor.h>

namespace at::native {

TORCH_IMPL_FUNC(softmax_cpu_out)
(const Tensor& input, const int64_t dim, const bool half_to_float, const Tensor& output) {
  host_softmax(output, input, dim);
}

Tensor softmax(const Tensor& input_, const int64_t dim, std::optional<ScalarType> dtype) {
  auto result = at::_softmax(input_, dim, false);
  return result;
}

Tensor& softmax_out(const Tensor& input_, const int64_t dim, std::optional<ScalarType> dtype, Tensor& output_) {
  return output_;
}

Tensor split(const Tensor& self, int64_t split_size, int64_t dim) {
  return self;
}

} // namespace at::native

namespace at::native {

Tensor log_softmax_like(const Tensor& self, int64_t dim) {
  return at::_ops::_softmax::call(self, dim, false);
}

} // namespace at::native

namespace at::native {

Tensor plain_call(const Tensor& x) {
  return _softmax(x, 1, false);
}

void scatter_on(c10::DeviceType dev, const Tensor& out, const Tensor& index, const Tensor& src) {
  scatter_add_stub(dev, out, 0, index, src);
}

} // namespace at::native
