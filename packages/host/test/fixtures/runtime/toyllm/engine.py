from toyllm.model_runner import ModelRunner
from toyllm.scheduler import Scheduler, Sequence


class LLMEngine:
    def __init__(self):
        self.scheduler = Scheduler()
        self.model_runner = ModelRunner()

    def step(self):
        seqs, is_prefill = self.scheduler.schedule()
        token_ids = self.model_runner.call("run", seqs, is_prefill)
        self.scheduler.postprocess(seqs, token_ids)
        return len(seqs)

    def generate(self, prompts, steps=3):
        for p in prompts:
            self.scheduler.add(Sequence(p))
        for _ in range(steps):
            self.step()
