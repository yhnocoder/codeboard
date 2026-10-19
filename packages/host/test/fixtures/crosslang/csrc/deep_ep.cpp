#include <pybind11/pybind11.h>
#include "kernels/api.cuh"

namespace deep_ep {

torch::Tensor Buffer::intranode_dispatch(const torch::Tensor& x, int num_ranks) {
    auto recv_x = torch::empty_like(x);
    intranode::dispatch(recv_x.data_ptr(), x.size(0), num_ranks, stream, 20);
    return recv_x;
}

}  // namespace deep_ep

PYBIND11_MODULE(TORCH_EXTENSION_NAME, m) {
    pybind11::class_<deep_ep::Buffer>(m, "Buffer")
        .def(pybind11::init<int>())
        .def("intranode_dispatch", &deep_ep::Buffer::intranode_dispatch)
        .def("jit_dispatch", &deep_ep::Buffer::jit_dispatch);
}
