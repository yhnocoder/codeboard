import torch
from torch._C import _add_docstr


def softmax(input, dim=None):
    return input.softmax(dim)


def fractional_max_pool2d(input, kernel_size, output_size, _random_samples):
    return torch._C._nn.fractional_max_pool2d(input, kernel_size, output_size, _random_samples)


gelu = _add_docstr(torch._C._nn.gelu, "gelu(input) -> Tensor")
