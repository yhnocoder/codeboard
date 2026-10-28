#pragma once
namespace at::native {

using scatter_add_fn = void (*)(const Tensor& self, int64_t dim, const Tensor& index, const Tensor& src);
DECLARE_DISPATCH(scatter_add_fn, scatter_add_stub)

} // namespace at::native
