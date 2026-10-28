from functorch import _C


def wrap(d):
    return _C._wrap_dim(d)
