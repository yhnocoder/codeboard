namespace at::native {

void scatter_add_cuda_kernel(const Tensor& self, int64_t dim, const Tensor& index, const Tensor& src) {
  launch(self, dim, index, src);
}

REGISTER_DISPATCH(scatter_add_stub, &scatter_add_cuda_kernel)

} // namespace at::native
