namespace at::native {

#define CREATE_COMPARISON_SCALAR_TENSOR_IMPL_FUNC(func)            \
  TORCH_IMPL_FUNC(func##_Tensor_out)                                \
  (const Tensor& self, const Tensor& other, const Tensor& result) { \
    func##_stub(device_type(), *this);                              \
  }                                                                 \
  TORCH_IMPL_FUNC(func##_Scalar_out)                                \
  (const Tensor& self, const Scalar& other, const Tensor& result) { \
    func##_stub(device_type(), *this);                              \
  }

CREATE_COMPARISON_SCALAR_TENSOR_IMPL_FUNC(eq);

} // namespace at::native
