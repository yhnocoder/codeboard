import torch
import torch.nn.functional as F


def run(x, idx, w):
    y = torch.add(x, w)
    z = F.softmax(y, 1)
    g = F.gelu(z)
    p = torch._C._nn.fractional_max_pool2d(g, 2, 2, w)
    u = torch.ops.aten._upsample_bilinear2d_aa(g, [4, 4], False)
    s = torch.split(u, 2)
    c = torch._C._get_cudnn_enabled()
    q = torch.acos(x)
    a = torch._C._mtia_is_available()
    e = torch.eq(x, 1)
    f = torch._foreach_add([x], 1)
    return x.scatter_add(0, idx, w)
