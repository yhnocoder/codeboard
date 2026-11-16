import torch


class Attention:
    def forward(self, q, k, v):
        if self.use_direct_call:
            return self.impl.forward(self, q, k, v)
        return torch.ops.vllm.unified_attention(q, k, v, self.layer_name)


def unified_attention(query, key, value, layer_name):
    return query


direct_register_custom_op("unified_attention", op_func=unified_attention)
