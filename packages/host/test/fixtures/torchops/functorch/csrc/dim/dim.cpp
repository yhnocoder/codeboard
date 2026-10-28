#include <Python.h>

static PyObject* _wrap_dim(PyObject* self, PyObject* args) {
  Py_RETURN_NONE;
}

static PyMethodDef methods[] = {
    {"_wrap_dim", (PyCFunction)_wrap_dim, METH_VARARGS, nullptr},
    {nullptr, nullptr, 0, nullptr},
};
