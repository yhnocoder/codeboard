namespace at::native {
namespace {

void scatter_add_cpu_kernel(const Tensor& self, int64_t dim, const Tensor& index, const Tensor& src) {
  loop(self, dim, index, src);
}

} // namespace

REGISTER_DISPATCH(scatter_add_stub, &scatter_add_cpu_kernel)

} // namespace at::native
