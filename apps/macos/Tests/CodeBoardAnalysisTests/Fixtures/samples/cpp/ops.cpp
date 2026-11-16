#include <torch/extension.h>

torch::Tensor rms_norm(torch::Tensor x, torch::Tensor w, double eps) {
  TORCH_CHECK(x.is_cuda(), "x must be CUDA");
  auto out = torch::empty_like(x);
  for (int64_t i = 0; i < x.size(0); ++i)
    out[i] = x[i] * torch::rsqrt(x[i].pow(2).mean() + eps) * w;
  return out;
}

PYBIND11_MODULE(TORCH_EXTENSION_NAME, m) {
  m.def("rms_norm", &rms_norm, "RMSNorm");  // 绑定
}
