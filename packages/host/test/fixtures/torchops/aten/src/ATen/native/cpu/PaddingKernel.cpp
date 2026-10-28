namespace at::native {
namespace {

template <typename scalar_t>
inline void add_stub(scalar_t* grad_in, const scalar_t* grad_out, int64_t size) {
  for (int64_t i = 0; i < size; i++) grad_in[i] += grad_out[i];
}

void reflection_pad_backward(float* grad_input_ptr, const float* grad_output_ptr, int64_t channels) {
  add_stub(grad_input_ptr, grad_output_ptr, channels);
}

} // namespace
} // namespace at::native
