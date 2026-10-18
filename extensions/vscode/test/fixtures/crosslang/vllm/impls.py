from vllm.base import AttentionImpl


class FlashAttentionImpl(AttentionImpl):
    def forward(self, layer, q, k, v):
        return q


class TritonAttentionImpl(AttentionImpl):
    def forward(self, layer, q, k, v):
        return k
