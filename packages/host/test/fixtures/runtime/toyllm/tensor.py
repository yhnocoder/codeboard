class Tensor:
    """Stands in for torch.Tensor: the tracer records shape / dtype only."""

    def __init__(self, shape, dtype="float16"):
        self.shape = tuple(shape)
        self.dtype = dtype

    def argmax(self, dim=-1):
        return [0] * self.shape[0]
