#include <torch/library.h>

void rms_norm_cuda(torch::Tensor& out, const torch::Tensor& x, const torch::Tensor& w) {
    out.copy_(x * w);
}

TORCH_LIBRARY_FRAGMENT(my_ext, m) {
  m.def("rms_norm(Tensor x, Tensor w) -> Tensor");
  m.impl("rms_norm", torch::kCUDA, &rms_norm_cuda);
}
