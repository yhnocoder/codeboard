#include <Python.h>

static PyObject* THPModule_userEnabledCuDNN(PyObject* _unused, PyObject* noargs) {
  Py_RETURN_TRUE;
}

static PyObject* THPModule_setEnabledCuDNN(PyObject* _unused, PyObject* arg) {
  Py_RETURN_NONE;
}

static std::initializer_list<PyMethodDef> TorchMethods = {
    {"_get_cudnn_enabled", THPModule_userEnabledCuDNN, METH_NOARGS, nullptr},
    {"_set_cudnn_enabled", castPyCFunctionWithKeywords(THPModule_setEnabledCuDNN), METH_O, nullptr},
};
