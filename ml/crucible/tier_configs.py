"""Per-tier training configurations for Lexel v2 (Lite 0.5B, Standard 1.5B, and Qwen3-1.7B bake-off).

Every hyperparameter here is grounded in `ml/RESEARCH_NOTES.md`:
- Thinking Machines "LoRA Without Regret" (`all-linear` targeting, `lora_alpha = 2 * r`, eff BS <= 32).
- Prose Session 2 empirical 2.0-epoch SFT ceiling (`session-2-factual-integrity-audit.md`).
- Prose Dual-Band Masked-SimPO (`alpha = 0.05`, `sft_weight = 0.05`, reference-free length-normalized margin).
- Kaggle T4 16 GB VRAM safety (`fp16` on Turing SM 7.5, `bf16` on Ampere+, `adamw_8bit`, Unsloth checkpointing).
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIGS_DIR = REPO_ROOT / "ml" / "configs"

ALL_LINEAR_TARGET_MODULES: tuple[str, ...] = (
    "q_proj",
    "k_proj",
    "v_proj",
    "o_proj",
    "gate_proj",
    "up_proj",
    "down_proj",
)


@dataclass(frozen=True)
class TierTrainingConfig:
    tier_id: str
    label: str
    tier_kind: str  # "lite" | "standard" | "bakeoff"
    unsloth_model_id: str
    hf_model_id: str
    chat_template: str
    enable_thinking: bool
    instruction_part: str
    response_part: str
    max_seq_length: int
    # LoRA
    lora_r: int
    lora_alpha: int
    lora_dropout: float
    target_modules: tuple[str, ...]
    # Stage 1 SFT
    sft_learning_rate: float
    sft_epochs: float
    sft_per_device_batch_size: int
    sft_grad_accum_steps: int
    sft_warmup_ratio: float
    sft_weight_decay: float
    sft_eval_steps: int
    sft_save_steps: int
    # Stage 2 Masked-SimPO
    simpo_beta: float
    simpo_gamma: float
    simpo_unmasked_token_weight: float
    simpo_sft_weight: float
    simpo_learning_rate: float
    simpo_epochs: float
    simpo_per_device_batch_size: int
    simpo_grad_accum_steps: int
    simpo_warmup_ratio: float
    simpo_weight_decay: float
    # GGUF Export
    quant_methods: tuple[str, ...]
    gguf_filename_prefix: str
    ollama_tag: str
    approx_ram_mb_q4: int
    approx_ram_mb_q5: int
    seed: int = 42

    def gguf_filename(self, quant: str) -> str:
        return f"{self.gguf_filename_prefix}-{quant}.gguf"

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["target_modules"] = list(self.target_modules)
        d["quant_methods"] = list(self.quant_methods)
        d["effective_sft_batch_size"] = (
            self.sft_per_device_batch_size * self.sft_grad_accum_steps
        )
        d["effective_simpo_batch_size"] = (
            self.simpo_per_device_batch_size * self.simpo_grad_accum_steps
        )
        return d


TIER_CONFIGS: dict[str, TierTrainingConfig] = {
    "lexel-0.5b": TierTrainingConfig(
        tier_id="lexel-0.5b",
        label="Lexel 0.5B (Lite)",
        tier_kind="lite",
        unsloth_model_id="unsloth/Qwen2.5-0.5B-Instruct-bnb-4bit",
        hf_model_id="Qwen/Qwen2.5-0.5B-Instruct",
        chat_template="qwen-2.5",
        enable_thinking=False,
        instruction_part="<|im_start|>user\n",
        response_part="<|im_start|>assistant\n",
        max_seq_length=1536,
        lora_r=16,
        lora_alpha=32,
        lora_dropout=0.0,
        target_modules=ALL_LINEAR_TARGET_MODULES,
        sft_learning_rate=3e-4,
        sft_epochs=2.0,
        sft_per_device_batch_size=2,
        sft_grad_accum_steps=8,
        sft_warmup_ratio=0.05,
        sft_weight_decay=0.01,
        sft_eval_steps=50,
        sft_save_steps=100,
        simpo_beta=2.0,
        simpo_gamma=0.8,
        simpo_unmasked_token_weight=0.05,
        simpo_sft_weight=0.05,
        simpo_learning_rate=8e-6,
        simpo_epochs=1.5,
        simpo_per_device_batch_size=2,
        simpo_grad_accum_steps=8,
        simpo_warmup_ratio=0.10,
        simpo_weight_decay=0.01,
        quant_methods=("q4_k_m", "q5_k_m"),
        gguf_filename_prefix="qwen2.5-0.5b-instruct",
        ollama_tag="qwen2.5:0.5b",
        approx_ram_mb_q4=450,
        approx_ram_mb_q5=520,
    ),
    "lexel-1.5b": TierTrainingConfig(
        tier_id="lexel-1.5b",
        label="Lexel 1.5B (Standard)",
        tier_kind="standard",
        unsloth_model_id="unsloth/Qwen2.5-1.5B-Instruct-bnb-4bit",
        hf_model_id="Qwen/Qwen2.5-1.5B-Instruct",
        chat_template="qwen-2.5",
        enable_thinking=False,
        instruction_part="<|im_start|>user\n",
        response_part="<|im_start|>assistant\n",
        max_seq_length=1536,
        lora_r=32,
        lora_alpha=64,
        lora_dropout=0.0,
        target_modules=ALL_LINEAR_TARGET_MODULES,
        sft_learning_rate=2e-4,
        sft_epochs=2.0,
        sft_per_device_batch_size=2,
        sft_grad_accum_steps=8,
        sft_warmup_ratio=0.05,
        sft_weight_decay=0.01,
        sft_eval_steps=50,
        sft_save_steps=100,
        simpo_beta=2.0,
        simpo_gamma=1.0,
        simpo_unmasked_token_weight=0.05,
        simpo_sft_weight=0.05,
        simpo_learning_rate=5e-6,
        simpo_epochs=1.5,
        simpo_per_device_batch_size=2,
        simpo_grad_accum_steps=8,
        simpo_warmup_ratio=0.10,
        simpo_weight_decay=0.01,
        quant_methods=("q4_k_m", "q5_k_m"),
        gguf_filename_prefix="qwen2.5-1.5b-instruct",
        ollama_tag="qwen2.5:1.5b",
        approx_ram_mb_q4=950,
        approx_ram_mb_q5=1150,
    ),
    "qwen3-1.7b-bakeoff": TierTrainingConfig(
        tier_id="qwen3-1.7b-bakeoff",
        label="Qwen3 1.7B Non-Thinking (Bake-Off)",
        tier_kind="bakeoff",
        unsloth_model_id="unsloth/Qwen3-1.7B-unsloth-bnb-4bit",
        hf_model_id="Qwen/Qwen3-1.7B",
        chat_template="qwen-3",
        enable_thinking=False,
        instruction_part="<|im_start|>user\n",
        response_part="<|im_start|>assistant\n",
        max_seq_length=1536,
        lora_r=32,
        lora_alpha=64,
        lora_dropout=0.0,
        target_modules=ALL_LINEAR_TARGET_MODULES,
        sft_learning_rate=1.5e-4,
        sft_epochs=2.0,
        sft_per_device_batch_size=2,
        sft_grad_accum_steps=8,
        sft_warmup_ratio=0.05,
        sft_weight_decay=0.01,
        sft_eval_steps=50,
        sft_save_steps=100,
        simpo_beta=2.0,
        simpo_gamma=1.0,
        simpo_unmasked_token_weight=0.05,
        simpo_sft_weight=0.05,
        simpo_learning_rate=4e-6,
        simpo_epochs=1.5,
        simpo_per_device_batch_size=2,
        simpo_grad_accum_steps=8,
        simpo_warmup_ratio=0.10,
        simpo_weight_decay=0.01,
        quant_methods=("q4_k_m", "q5_k_m"),
        gguf_filename_prefix="qwen3-1.7b-nonthinking",
        ollama_tag="qwen3:1.7b",
        approx_ram_mb_q4=1150,
        approx_ram_mb_q5=1400,
    ),
}


def get_tier_config(tier_id: str) -> TierTrainingConfig:
    if tier_id not in TIER_CONFIGS:
        valid = ", ".join(sorted(TIER_CONFIGS))
        raise KeyError(f"Unknown Lexel tier {tier_id!r}. Valid tiers: {valid}")
    return TIER_CONFIGS[tier_id]


def write_tier_config_files(output_dir: Path = CONFIGS_DIR) -> list[Path]:
    """Write machine-readable per-tier JSON configs under `ml/configs/`."""
    output_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for tier_id, cfg in TIER_CONFIGS.items():
        path = output_dir / f"{tier_id}.json"
        path.write_text(json.dumps(cfg.to_dict(), indent=2) + "\n", encoding="utf-8")
        written.append(path)
    return written


if __name__ == "__main__":
    for p in write_tier_config_files():
        print(f"Wrote {p.relative_to(REPO_ROOT)}")
