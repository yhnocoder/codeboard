namespace at::native {

TORCH_IMPL_FUNC(fractional_max_pool2d_out_cpu) (
  const at::Tensor& input_, IntArrayRef pool_size, IntArrayRef output_size, const at::Tensor& randomSamples_, const at::Tensor& output, const at::Tensor& indices) {
  fractional_max_pool2d_out_frame(input_, output, indices);
}

TORCH_IMPL_FUNC(_upsample_bilinear2d_aa_out_cpu) (const Tensor& input, IntArrayRef output_size, bool align_corners, const Tensor& output) {
  upsample_kernel(output, input);
}

Tensor _upsample_bilinear2d_aa(const Tensor& input, at::OptionalIntArrayRef output_size, bool align_corners, std::optional<ArrayRef<double>> scale_factors) {
  return at::_upsample_bilinear2d_aa(input, *output_size, align_corners);
}

Tensor gelu_kernel(const Tensor& self, std::string_view approximate) {
  return self;
}

} // namespace at::native
