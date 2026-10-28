#include <ATen/functorch/BatchRulesHelper.h>

namespace at::functorch {

TORCH_LIBRARY_IMPL(aten, FuncTorchBatchedDecomposition, m) {
  m.impl("_upsample_bilinear2d_aa", native::_upsample_bilinear2d_aa);
}

} // namespace at::functorch
