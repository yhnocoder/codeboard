namespace at::native {

template <typename scalar_t>
__global__ void fractional_max_pool2d_out_cuda_frame(scalar_t* output, int64_t* indices) {
}

TORCH_IMPL_FUNC(fractional_max_pool2d_out_cuda) (
  const Tensor& input, IntArrayRef pool_size, IntArrayRef output_size, const Tensor& randomSamples, const Tensor& output, const Tensor& indices) {
  fractional_max_pool2d_out_cuda_frame<float><<<1, 32>>>(output.data_ptr<float>(), indices.data_ptr<int64_t>());
}

TORCH_IMPL_FUNC(_upsample_bilinear2d_aa_out_cuda) (const Tensor& input, IntArrayRef output_size, bool align_corners, const Tensor& output) {
  upsample_gen2d_aa_out_cuda_template(output, input);
}

} // namespace at::native
