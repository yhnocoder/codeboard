from toyllm.tensor import Tensor


class ModelRunner:
    def __init__(self, hidden=64):
        self.hidden = hidden

    def call(self, method_name, *args):
        method = getattr(self, method_name, None)
        return method(*args)

    def prepare(self, seqs, is_prefill):
        n = sum(len(s.prompt) for s in seqs) if is_prefill else len(seqs)
        return Tensor((n, self.hidden))

    def run(self, seqs, is_prefill):
        hidden = self.prepare(seqs, is_prefill)
        return self.sample(hidden, temperature=0.0)

    def sample(self, logits, temperature):
        return logits.argmax(-1)
