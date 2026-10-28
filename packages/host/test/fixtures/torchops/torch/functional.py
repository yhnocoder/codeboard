import torch


def split(tensor, split_size_or_sections, dim=0):
    return tensor.split(split_size_or_sections, dim)
