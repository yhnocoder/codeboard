# Tiny entry for Capture Run: no torch, no GPU.
import sys

from toyllm.engine import LLMEngine

if __name__ == "__main__":
    steps = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    LLMEngine().generate(["hello", "world"], steps=steps)
