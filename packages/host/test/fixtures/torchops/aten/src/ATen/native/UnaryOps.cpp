namespace at::native {

#define CREATE_UNARY_TORCH_IMPL_FUNC(func_out, func_stub)                                \
TORCH_IMPL_FUNC(func_out) (const Tensor& self, const Tensor& result) {  \
  func_stub(device_type(), *this);                                       \
}

CREATE_UNARY_TORCH_IMPL_FUNC(acos_out, acos_stub)

} // namespace at::native
