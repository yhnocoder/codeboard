#include <torch/csrc/utils/pybind.h>

namespace torch::mtia {

bool is_available() {
  return true;
}

void initModule(PyObject* module) {
  auto m = py::handle(module).cast<py::module>();
  m.def("_mtia_isBuilt", []() { return true; });
  m.def("_mtia_is_available", torch::wrap_pybind_function(is_available));
}

} // namespace torch::mtia
