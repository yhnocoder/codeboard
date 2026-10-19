class Sequence:
    def __init__(self, prompt):
        self.prompt = prompt
        self.tokens = []


class BlockManager:
    def __init__(self, num_blocks):
        self.free = num_blocks

    def allocate(self, seq):
        self.free -= 1


class Scheduler:
    def __init__(self, num_blocks=16):
        self.block_manager = BlockManager(num_blocks)
        self.waiting = []
        self.running = []

    def add(self, seq):
        self.waiting.append(seq)

    def schedule(self):
        if self.waiting:
            seqs = self.waiting
            for seq in seqs:
                self.block_manager.allocate(seq)
            self.running.extend(seqs)
            self.waiting = []
            return seqs, True
        return self.running, False

    def postprocess(self, seqs, token_ids):
        for seq, tok in zip(seqs, token_ids):
            seq.tokens.append(tok)
