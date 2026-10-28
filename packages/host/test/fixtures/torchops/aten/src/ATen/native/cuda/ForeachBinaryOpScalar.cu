namespace at::native {

#define FOREACH_BINARY_OP_SCALAR(FUNCTION, NAME, OP)                     \
  std::vector<Tensor> foreach_tensor_##NAME##_scalar_kernel_cuda(        \
      TensorList tensors, const Scalar& scalar) {                        \
    return FUNCTION<OP>(tensors, scalar);                                 \
  }

FOREACH_BINARY_OP_SCALAR(all_types_complex_bool_half_bfloat16, add, std::plus);

} // namespace at::native
