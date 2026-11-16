// 简单的 kernel
#include <cuda_runtime.h>
#include "utils.h"

namespace flash {
namespace detail {

template <typename T, int N>
__global__ void add_kernel(T* __restrict__ out, const T* a, const T* b, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;  // 全局下标
  for (int k = i; k < n; k += gridDim.x * blockDim.x) {
    out[k] = combine<T>(a[k], b[k]);
    if (k % 2) { atomicAdd(out, a[k]); }
  }
  while (i < n) { i = next(i); }
  do { sync(); } while (cond(i));
  auto f = [&](int x) { for (;;) { return helper(x); } };
  int r = std::max(f(1), compute(a, b));
}

/* 多行
   注释 */
struct Params {
  int n;
  float scale = default_scale();
  int size() const { return n * stride(); }
  struct Inner { void g() { h(); } };
};

}  // namespace detail

void launch(float* out, const float* a, const float* b, int n, cudaStream_t s) {
  dim3 grid(div_up(n, 256));
  detail::add_kernel<float, 4><<<grid, 256, 0, s>>>(out, a, b, n);
  C10_CUDA_KERNEL_LAUNCH_CHECK();
  for (auto& x : items(n)) process(x);
  Params p; p.size();
  auto* q = make_ptr(n);
  value = obj->method(1, "s");
}

}  // namespace flash

extern "C" {
int c_api(int x) { return flash::launch_count(x); }
}

#ifdef USE_ROCM
static void rocm_only() { hipInit(0); }
#endif

class Engine : public Base {
 public:
  Engine() : Base(init()) {}
  template <class U> U get(U u) { return convert<U>(u); }
  ~Engine();
};
Engine::~Engine() { cleanup(); }
int Engine::helper(int v) { return v ? sizeof(v) : printf("x"); }
