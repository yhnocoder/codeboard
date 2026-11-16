class Qwen3ForCausalLM:
    packed_modules_mapping = {
        "q_proj": ("qkv_proj", "q"),
        "k_proj": ("qkv_proj", "k"),
    }
    tie = False

TABLE = [
    1,
    2,
]
x = 1
