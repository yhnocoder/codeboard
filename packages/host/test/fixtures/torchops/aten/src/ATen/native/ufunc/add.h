#pragma once

namespace at::native::ufunc {

template <typename T>
C10_HOST_DEVICE C10_ALWAYS_INLINE T add(T self, T other, T alpha) __ubsan_ignore_undefined__ {
  return self + alpha * other;
}

} // namespace at::native::ufunc
