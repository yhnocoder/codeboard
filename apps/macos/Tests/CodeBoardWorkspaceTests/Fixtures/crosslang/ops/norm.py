import torch


def rms_norm(x, w):
    out = torch.ops.my_ext.rms_norm(x, w)
    return out
