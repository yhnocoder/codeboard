#include <ATen/native/TensorAdvancedIndexing.h>

namespace at::native {

DEFINE_DISPATCH(scatter_add_stub);

TORCH_IMPL_FUNC(scatter_add)
(const Tensor& self, int64_t dim, const Tensor& index, const Tensor& src, const Tensor& out) {
  scatter_add_stub(self.device().type(), out, dim, index, src);
}

void index_add_cpu_(TensorIterator& iter, const Scalar& alpha) {
  add_stub(iter.device_type(), iter, alpha);
}

} // namespace at::native
