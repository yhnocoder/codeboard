#pragma once

#define FOREACH_BINARY_OP_SCALAR(OP)                                                          \
  std::vector<Tensor> foreach_tensor_##OP##_scalar_kernel_slow(TensorList tensors, const Scalar& scalar) { \
    return {};                                                                                \
  }
