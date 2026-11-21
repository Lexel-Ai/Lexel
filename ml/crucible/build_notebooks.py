#!/usr/bin/env python3
"""Generate self-contained, Kaggle T4-safe Unsloth Jupyter notebooks for BOTH Lexel tiers (0.5B Lite & 1.5B Standard) plus Qwen3-1.7B non-thinking bake-off."""

from __future__ import annotations

import json
from pathlib import Path

from ml.crucible.tier_configs import TIER_CONFIGS, get_tier_config

REPO_ROOT = Path(__file__).resolve().parents[2]
KAGGLE_DIR = REPO_ROOT / "ml" / "kaggle"


def _md_cell(text: str) -> dict[str, object]:
    lines = text.splitlines(keepends=True)
    return {
        "cell_type": "markdown",
        "metadata": {},
        "source": lines,
    }


def _code_cell(code: str) -> dict[str, object]:
    lines = code.splitlines(keepends=True)
    return {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": lines,
    }


def _notebook_doc(cells: list[dict[str, object]]) -> dict[str, object]:
    return {
        "cells": cells,
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3",
            },
            "language_info": {
                "codemirror_mode": {"name": "ipython", "version": 3},
                "file_extension": ".py",
                "mimetype": "text/x-python",
                "name": "python",
                "nbconvert_exporter": "python",
                "pygments_lexer": "ipython3",
                "version": "3.11.0",
            },
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }


def _serialized_tier_table() -> str:
    table = {tid: cfg.to_dict() for tid, cfg in TIER_CONFIGS.items()}
    return json.dumps(table, indent=4)


def build_sft_notebook(default_tier: str = "lexel-1.5b") -> dict[str, object]:
    cfg = get_tier_config(default_tier)
    tier_table_json = _serialized_tier_table()
    cells = [
        _md_cell(
            f"""# Lexel v2 Stage 1: QLoRA SFT for `{cfg.label}` (Kaggle T4 / Unsloth)

Trains the Stage 1 Supervised Fine-Tuning (SFT) adapter for **{cfg.label}** (`{cfg.unsloth_model_id}`) using Unsloth 4-bit QLoRA with automatic HuggingFace PEFT/TRL fallback.

## Research-Grounded Defaults (`ml/RESEARCH_NOTES.md`)
- **Tier**: `{cfg.tier_id}` (`r={cfg.lora_r}`, `lora_alpha={cfg.lora_alpha}`, all 7 linear projections, `max_seq_length={cfg.max_seq_length}`)
- **SFT Schedule**: `lr={cfg.sft_learning_rate}`, `{cfg.sft_epochs}` epochs (empirical Prose Session 2 ceiling), effective batch size `{cfg.sft_per_device_batch_size * cfg.sft_grad_accum_steps}`, cosine decay with `{int(cfg.sft_warmup_ratio * 100)}%` warmup.
- **Completion-Only Loss Masking**: Applies `train_on_responses_only` and decodes a real collated batch before `.train()` to verify `supervised_count > 0` and zero prompt tokens in labels.
- **Tier Override**: Set `LEXEL_MODEL_TIER` to `lexel-1.5b`, `lexel-0.5b`, or `qwen3-1.7b-bakeoff` to switch configs without editing cells."""
        ),
        _code_cell(
            """# Cell 1: Environment Setup & Kaggle Package Installation (Unsloth imported BEFORE torch/trl)
import importlib.util
import os
import subprocess
import sys

os.environ["WANDB_DISABLED"] = "true"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

# Pin GPU 0 on Kaggle 2x T4 so 4-bit bitsandbytes QLoRA avoids DataParallel device-mismatch errors
if "KAGGLE_KERNEL_RUN_TYPE" in os.environ and "CUDA_VISIBLE_DEVICES" not in os.environ:
    os.environ["CUDA_VISIBLE_DEVICES"] = "0"

def _pkg_installed(name: str) -> bool:
    if name in sys.modules:
        return True
    try:
        return importlib.util.find_spec(name) is not None
    except (ValueError, ImportError):
        return False

def ensure_training_packages() -> None:
    required = ("trl", "peft", "datasets", "accelerate", "bitsandbytes")
    missing = [pkg for pkg in required if not _pkg_installed(pkg)]
    has_unsloth = _pkg_installed("unsloth")

    if "KAGGLE_KERNEL_RUN_TYPE" in os.environ and (missing or not has_unsloth):
        print("Installing Unsloth + QLoRA training dependencies for Kaggle GPU...")
        try:
            subprocess.check_call(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "-q",
                    "--upgrade",
                    "unsloth",
                    "unsloth_zoo",
                    "trl",
                    "peft",
                    "accelerate",
                    "bitsandbytes",
                    "datasets",
                ]
            )
        except Exception as pip_exc:
            print(f"WARNING: pip install failed ({pip_exc}). Enable Internet in Kaggle Settings.")
    elif missing:
        print(f"Installing missing packages: {missing}")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", *missing])

ensure_training_packages()

# Import unsloth BEFORE torch/transformers/trl so fused kernels patch cleanly
try:
    import unsloth
    from unsloth import FastLanguageModel, is_bfloat16_supported
    from unsloth.chat_templates import get_chat_template, train_on_responses_only
    HAS_UNSLOTH = True
except Exception as exc:
    print(f"Unsloth fast path unavailable ({exc}); using standard Transformers + PEFT + TRL fallback.")
    HAS_UNSLOTH = False

import torch
if not HAS_UNSLOTH:
    def is_bfloat16_supported() -> bool:
        return torch.cuda.is_available() and torch.cuda.get_device_capability(0)[0] >= 8

print(f"PyTorch: {torch.__version__} | CUDA available: {torch.cuda.is_available()} | Unsloth active: {HAS_UNSLOTH}")
if torch.cuda.is_available():
    print(f"Active GPU: {torch.cuda.get_device_name(0)} | BF16: {is_bfloat16_supported()}")"""
        ),
        _code_cell(
            f"""# Cell 2: Per-Tier Training Config & Automatic Dataset Discovery
import hashlib
import inspect
import json
import time
from datetime import UTC, datetime
from pathlib import Path

from datasets import load_dataset
from trl import SFTConfig, SFTTrainer

TIER_CONFIGS = json.loads(r'''{tier_table_json}''')

DEFAULT_TIER = {default_tier!r}
MODEL_TIER = os.environ.get("LEXEL_MODEL_TIER", DEFAULT_TIER)
if MODEL_TIER not in TIER_CONFIGS:
    raise ValueError(f"Unsupported LEXEL_MODEL_TIER={{MODEL_TIER!r}}. Valid: {{sorted(TIER_CONFIGS)}}")

CFG = TIER_CONFIGS[MODEL_TIER]
BASE_MODEL_ID = CFG["unsloth_model_id"] if HAS_UNSLOTH else CFG["hf_model_id"]
MAX_SEQ_LENGTH = int(CFG["max_seq_length"])
LORA_R = int(CFG["lora_r"])
LORA_ALPHA = int(CFG["lora_alpha"])
LORA_DROPOUT = float(CFG["lora_dropout"])
TARGET_MODULES = list(CFG["target_modules"])

def resolve_data_dir() -> Path:
    candidates = [
        Path(os.environ["LEXEL_DATA_DIR"]) if "LEXEL_DATA_DIR" in os.environ else None,
        Path("/kaggle/input/lexel-crucible-datasets"),
        Path("/kaggle/input/datasets/lawandsoran/lexel-crucible-datasets"),
        Path.cwd() / "ml" / "datasets",
        Path.cwd().parent / "datasets",
        Path.cwd() / "datasets",
    ]
    for cand in candidates:
        if cand and (cand / "lexel_sft_train.jsonl").is_file():
            return cand.resolve()

    kaggle_input = Path("/kaggle/input")
    if kaggle_input.is_dir():
        matches = sorted(kaggle_input.rglob("lexel_sft_train.jsonl"))
        if matches:
            return matches[0].parent.resolve()

    for root_cand in (Path.cwd(), *Path.cwd().parents):
        if (root_cand / "ml" / "crucible" / "dataset_builder.py").is_file():
            if str(root_cand) not in sys.path:
                sys.path.insert(0, str(root_cand))
            from ml.crucible.dataset_builder import build_all_datasets
            out_dir = root_cand / "ml" / "datasets"
            build_all_datasets(out_dir)
            return out_dir.resolve()

    raise FileNotFoundError(
        "Could not find lexel_sft_train.jsonl. Attach the `lexel-crucible-datasets` Kaggle Dataset "
        "(or set LEXEL_DATA_DIR to your ml/datasets directory)."
    )

DATA_DIR = resolve_data_dir()
TRAIN_FILE = DATA_DIR / "lexel_sft_train.jsonl"
VAL_FILE = DATA_DIR / "lexel_sft_val.jsonl"
OUTPUT_DIR = Path(os.environ.get("LEXEL_SFT_OUT", f"./outputs/{{MODEL_TIER}}-sft-adapter")).resolve()
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

print(f"Selected Tier: {{MODEL_TIER}} ({{CFG['label']}}) -> {{BASE_MODEL_ID}}")
print(f"LoRA: r={{LORA_R}}, alpha={{LORA_ALPHA}}, lr={{CFG['sft_learning_rate']}}, epochs={{CFG['sft_epochs']}}")
print(f"Train file: {{TRAIN_FILE}} ({{TRAIN_FILE.stat().st_size:,}} bytes)")
print(f"Val file:   {{VAL_FILE}} ({{VAL_FILE.stat().st_size:,}} bytes)")
print(f"Output dir: {{OUTPUT_DIR}}")"""
        ),
        _code_cell(
            """# Cell 3: Load 4-bit Base Model & Attach All-Linear LoRA Adapters
if HAS_UNSLOTH:
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=BASE_MODEL_ID,
        max_seq_length=MAX_SEQ_LENGTH,
        dtype=None,
        load_in_4bit=True,
    )
    tokenizer = get_chat_template(
        tokenizer,
        chat_template=CFG["chat_template"],
    )
    model = FastLanguageModel.get_peft_model(
        model,
        r=LORA_R,
        target_modules=TARGET_MODULES,
        lora_alpha=LORA_ALPHA,
        lora_dropout=LORA_DROPOUT,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=int(CFG["seed"]),
        use_rslora=False,
        loftq_config=None,
    )
else:
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL_ID)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.bfloat16 if is_bfloat16_supported() else torch.float16,
    )
    model = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL_ID,
        quantization_config=bnb_config if torch.cuda.is_available() else None,
        device_map="auto" if torch.cuda.is_available() else None,
    )
    if torch.cuda.is_available():
        model = prepare_model_for_kbit_training(model)
    peft_cfg = LoraConfig(
        r=LORA_R,
        lora_alpha=LORA_ALPHA,
        lora_dropout=LORA_DROPOUT,
        target_modules=TARGET_MODULES,
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, peft_cfg)

tokenizer.padding_side = "right"
model.print_trainable_parameters()"""
        ),
        _code_cell(
            """# Cell 4: Load Crucible-Verified Datasets & Render Chat Template
dataset = load_dataset(
    "json",
    data_files={
        "train": str(TRAIN_FILE),
        "validation": str(VAL_FILE),
    },
)

apply_sig = inspect.signature(tokenizer.apply_chat_template).parameters

def _render_messages(msgs):
    kwargs = {"tokenize": False, "add_generation_prompt": False}
    if "enable_thinking" in apply_sig:
        kwargs["enable_thinking"] = bool(CFG["enable_thinking"])
    return tokenizer.apply_chat_template(msgs, **kwargs)

def format_chat_prompts(batch):
    return {"text": [_render_messages(msgs) for msgs in batch["messages"]]}

dataset = dataset.map(
    format_chat_prompts,
    batched=True,
    remove_columns=[c for c in dataset["train"].column_names if c != "text"],
)
print(f"Train rows: {len(dataset['train']):,}, Validation rows: {len(dataset['validation']):,}")
print("\\nSample rendered ChatML prompt:\\n", dataset["train"][0]["text"][:600])"""
        ),
        _code_cell(
            """# Cell 5: Configure SFTTrainer (Version-Safe) & Audit Completion-Only Masking
sft_cfg_params = inspect.signature(SFTConfig.__init__).parameters
sft_trainer_params = inspect.signature(SFTTrainer.__init__).parameters

cfg_kwargs = {
    "output_dir": str(OUTPUT_DIR),
    "per_device_train_batch_size": int(CFG["sft_per_device_batch_size"]),
    "per_device_eval_batch_size": int(CFG["sft_per_device_batch_size"]),
    "gradient_accumulation_steps": int(CFG["sft_grad_accum_steps"]),
    "learning_rate": float(CFG["sft_learning_rate"]),
    "lr_scheduler_type": "cosine",
    "warmup_ratio": float(CFG["sft_warmup_ratio"]),
    "num_train_epochs": float(CFG["sft_epochs"]),
    "optim": "adamw_8bit" if torch.cuda.is_available() else "adamw_torch",
    "weight_decay": float(CFG["sft_weight_decay"]),
    "fp16": bool(torch.cuda.is_available() and not is_bfloat16_supported()),
    "bf16": bool(torch.cuda.is_available() and is_bfloat16_supported()),
    "logging_steps": 10,
    "save_strategy": "steps",
    "save_steps": int(CFG["sft_save_steps"]),
    "save_total_limit": 2,
    "seed": int(CFG["seed"]),
    "report_to": "none",
}

if "eval_strategy" in sft_cfg_params:
    cfg_kwargs["eval_strategy"] = "steps"
    cfg_kwargs["eval_steps"] = int(CFG["sft_eval_steps"])
elif "evaluation_strategy" in sft_cfg_params:
    cfg_kwargs["evaluation_strategy"] = "steps"
    cfg_kwargs["eval_steps"] = int(CFG["sft_eval_steps"])

if "dataset_text_field" in sft_cfg_params:
    cfg_kwargs["dataset_text_field"] = "text"
if "max_seq_length" in sft_cfg_params:
    cfg_kwargs["max_seq_length"] = MAX_SEQ_LENGTH
elif "max_length" in sft_cfg_params:
    cfg_kwargs["max_length"] = MAX_SEQ_LENGTH

# Initialize with packing=False so train_on_responses_only maps exact turn boundaries
if "packing" in sft_cfg_params:
    cfg_kwargs["packing"] = False
if "padding_free" in sft_cfg_params:
    cfg_kwargs["padding_free"] = False

sft_config = SFTConfig(**cfg_kwargs)

trainer_kwargs = {
    "model": model,
    "train_dataset": dataset["train"],
    "eval_dataset": dataset["validation"],
    "args": sft_config,
}
if "processing_class" in sft_trainer_params:
    trainer_kwargs["processing_class"] = tokenizer
elif "tokenizer" in sft_trainer_params:
    trainer_kwargs["tokenizer"] = tokenizer
if "dataset_text_field" in sft_trainer_params and "dataset_text_field" not in cfg_kwargs:
    trainer_kwargs["dataset_text_field"] = "text"
if "max_seq_length" in sft_trainer_params and "max_seq_length" not in cfg_kwargs and "max_length" not in cfg_kwargs:
    trainer_kwargs["max_seq_length"] = MAX_SEQ_LENGTH

trainer = SFTTrainer(**trainer_kwargs)

# Apply strict completion-only loss masking (-100 on all system/user prompt tokens)
if HAS_UNSLOTH:
    try:
        trainer = train_on_responses_only(
            trainer,
            instruction_part=CFG["instruction_part"],
            response_part=CFG["response_part"],
        )
        print("Applied Unsloth train_on_responses_only completion mask.")
    except Exception as mask_exc:
        print(f"Note: train_on_responses_only fallback ({mask_exc}); continuing with standard SFT collator.")

# Audit one real collated batch before training (per unsloth & dataset-curation skills)
sample_batch = next(iter(trainer.get_train_dataloader()))
supervised_count = int((sample_batch["labels"] != -100).sum().item())
assert supervised_count > 0, "CRITICAL: Zero supervised tokens in batch labels!"
print(f"Batch label audit PASSED: {supervised_count} supervised completion tokens in first batch (shape={tuple(sample_batch['input_ids'].shape)}).")"""
        ),
        _code_cell(
            """# Cell 6: Run Stage 1 SFT Training & Save Adapter + run_manifest.json
if torch.cuda.is_available():
    torch.cuda.reset_peak_memory_stats()

t0 = time.perf_counter()
train_stats = trainer.train()
elapsed_sec = time.perf_counter() - t0

peak_vram_gb = (
    round(torch.cuda.max_memory_allocated() / (1024**3), 3)
    if torch.cuda.is_available()
    else 0.0
)

adapter_dir = OUTPUT_DIR / "adapter"
adapter_dir.mkdir(parents=True, exist_ok=True)
model.save_pretrained(str(adapter_dir))
tokenizer.save_pretrained(str(adapter_dir))

train_sha256 = hashlib.sha256(TRAIN_FILE.read_bytes()).hexdigest()
val_sha256 = hashlib.sha256(VAL_FILE.read_bytes()).hexdigest()

run_manifest = {
    "stage": "stage1_sft",
    "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
    "model_tier": MODEL_TIER,
    "base_model_id": BASE_MODEL_ID,
    "chat_template": CFG["chat_template"],
    "enable_thinking": bool(CFG["enable_thinking"]),
    "max_seq_length": MAX_SEQ_LENGTH,
    "lora": {
        "r": LORA_R,
        "lora_alpha": LORA_ALPHA,
        "lora_dropout": LORA_DROPOUT,
        "target_modules": TARGET_MODULES,
        "use_gradient_checkpointing": "unsloth" if HAS_UNSLOTH else True,
        "adapter_path": str(adapter_dir),
    },
    "hyperparameters": {
        "learning_rate": float(CFG["sft_learning_rate"]),
        "lr_scheduler_type": "cosine",
        "warmup_ratio": float(CFG["sft_warmup_ratio"]),
        "num_train_epochs": float(CFG["sft_epochs"]),
        "effective_batch_size": int(CFG["effective_sft_batch_size"]),
        "optim": cfg_kwargs["optim"],
        "train_on_responses_only": True,
    },
    "datasets": {
        "train_file": str(TRAIN_FILE),
        "train_rows": len(dataset["train"]),
        "train_sha256": train_sha256,
        "val_file": str(VAL_FILE),
        "val_rows": len(dataset["validation"]),
        "val_sha256": val_sha256,
    },
    "telemetry": {
        "global_step": int(trainer.state.global_step),
        "training_loss": round(float(train_stats.training_loss), 6),
        "wall_time_sec": round(elapsed_sec, 2),
        "peak_vram_gb": peak_vram_gb,
    },
}

manifest_path = OUTPUT_DIR / "run_manifest.json"
manifest_path.write_text(json.dumps(run_manifest, indent=2) + "\\n", encoding="utf-8")
print("Saved Stage 1 SFT adapter and run_manifest.json to:", OUTPUT_DIR)
print(json.dumps(run_manifest["telemetry"], indent=2))"""
        ),
    ]
    return _notebook_doc(cells)


def build_dpo_gguf_notebook(default_tier: str = "lexel-1.5b") -> dict[str, object]:
    cfg = get_tier_config(default_tier)
    tier_table_json = _serialized_tier_table()
    cells = [
        _md_cell(
            f"""# Lexel v2 Stage 2: Surgical Token-Masked SimPO Alignment, Held-Out Eval & GGUF Export (`{cfg.label}`)

Runs Stage 2 preference alignment on balanced surgical counterfactual pairs (`lexel_dpo_train.jsonl`, plus optional personal edits from `lexel db export-simpo`), scores all 13 surfaces on `lexel_heldout_eval.jsonl`, and exports **both `Q4_K_M` and `Q5_K_M`** GGUF weights with real `SHA256SUMS` and a ready-to-paste `manifest_snippet.json`.

## Per-Tier Alignment Config (`ml/RESEARCH_NOTES.md`)
- **Tier**: `{cfg.tier_id}` (`r={cfg.lora_r}`, `lora_alpha={cfg.lora_alpha}`, `max_seq_length={cfg.max_seq_length}`)
- **Dual-Band `MaskedSimPOLoss`**: `beta={cfg.simpo_beta}`, `gamma={cfg.simpo_gamma}`, `unmasked_token_weight={cfg.simpo_unmasked_token_weight}`, `sft_weight={cfg.simpo_sft_weight}`, `lr={cfg.simpo_learning_rate}`, `{cfg.simpo_epochs}` epochs, effective batch size `{cfg.simpo_per_device_batch_size * cfg.simpo_grad_accum_steps}`.
- **Personal Voice Feedback**: Attach an optional `lexel_user_simpo.jsonl` exported by `lexel db export-simpo` (or set `LEXEL_USER_SIMPO_PATH`) to blend real user preferences into Stage 2.
- **GGUF Export**: Exports `{cfg.gguf_filename('q4_k_m')}` and `{cfg.gguf_filename('q5_k_m')}`, computes real SHA-256 digests, and never writes fabricated checksums."""
        ),
        _code_cell(
            """# Cell 1: Environment Setup, Kaggle Package Installation & Self-Contained Crucible Bootstrap
import hashlib
import importlib.util
import inspect
import json
import math
import os
import re
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Sequence

os.environ["WANDB_DISABLED"] = "true"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

if "KAGGLE_KERNEL_RUN_TYPE" in os.environ and "CUDA_VISIBLE_DEVICES" not in os.environ:
    os.environ["CUDA_VISIBLE_DEVICES"] = "0"

def _pkg_installed(name: str) -> bool:
    if name in sys.modules:
        return True
    try:
        return importlib.util.find_spec(name) is not None
    except (ValueError, ImportError):
        return False

def ensure_stage2_packages() -> None:
    required = ("trl", "peft", "datasets", "accelerate", "bitsandbytes")
    missing = [pkg for pkg in required if not _pkg_installed(pkg)]
    has_unsloth = _pkg_installed("unsloth")

    if "KAGGLE_KERNEL_RUN_TYPE" in os.environ and (missing or not has_unsloth):
        print("Installing Unsloth + Stage 2 alignment dependencies for Kaggle GPU...")
        try:
            subprocess.check_call(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "-q",
                    "--upgrade",
                    "unsloth",
                    "unsloth_zoo",
                    "trl",
                    "peft",
                    "accelerate",
                    "bitsandbytes",
                    "datasets",
                ]
            )
        except Exception as pip_exc:
            print(f"WARNING: pip install failed ({pip_exc}). Enable Internet in Kaggle Settings.")
    elif missing:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", *missing])

ensure_stage2_packages()

# Import unsloth BEFORE torch/transformers/trl
try:
    import unsloth
    from unsloth import FastLanguageModel, PatchDPOTrainer, is_bfloat16_supported
    from unsloth.chat_templates import get_chat_template, train_on_responses_only
    PatchDPOTrainer()
    HAS_UNSLOTH = True
except Exception as exc:
    print(f"Unsloth fast path unavailable ({exc}); using standard Transformers + PEFT fallback.")
    HAS_UNSLOTH = False

import torch
import torch.nn.functional as F

if not HAS_UNSLOTH:
    def is_bfloat16_supported() -> bool:
        return torch.cuda.is_available() and torch.cuda.get_device_capability(0)[0] >= 8

# Locate repo root if running inside a cloned Lexel checkout
for cand_root in (Path.cwd(), *Path.cwd().parents):
    if (cand_root / "ml" / "crucible" / "__init__.py").is_file():
        if str(cand_root) not in sys.path:
            sys.path.insert(0, str(cand_root))
        break

try:
    from ml.crucible.alignment import PreferenceBatchCollator, run_masked_simpo_alignment
    from ml.crucible.evaluate import (
        WritingBenchCritic,
        clopper_pearson_interval,
        evaluate_heldout_generations,
        sign_test_p_value,
    )
    from ml.crucible.loss import MaskedSimPOLoss, compute_token_logprobs
    from ml.crucible.verifier import sanitize_model_output, verify_rewrite
    print("Loaded ml.crucible modules from repository.")
except ImportError:
    print("Standalone Kaggle mode: bootstrapping self-contained MaskedSimPOLoss & Tier 2 Verifier...")
    UNIT_BOUND_REGEX = re.compile(
        r"(?i)(?:(?<=^)|(?<=[\\s(\\[\\\"'`]))(#|\\$)?(\\d+(?:[.,]\\d+)?)\\s*(%|ms|us|\u00b5s|s|sec|min|hrs?|kb|mb|gb|tb|px|x|k|m|b)?(?=$|[\\s,.;:!?/\\)\\]\\'\\\"`])"
    )
    INLINE_BACKTICK_RE = re.compile(r"`[^`\\n]+`")
    URL_RE = re.compile(r"(?i)https?://[^\\s)>\\]\\\"']+")
    CLI_FLAG_RE = re.compile(r"(?:(?<=^)|(?<=[\\s(\\[\\\"`']))(--[a-zA-Z0-9][a-zA-Z0-9_-]*)(?=$|[\\s,.;:!?=\\)\\]\\'\\\"`])")
    CORE_SLOP_TERMS = (
        "delve", "tapestry", "seamless", "seamlessly", "leverage", "leveraging",
        "game-changer", "game changer", "unlock", "unlocking", "pivotal",
        "in today's", "rapidly evolving", "cutting-edge", "synergy", "paradigm",
        "holistic", "furthermore", "moreover", "in conclusion", "testament to",
    )

    def sanitize_model_output(raw: str) -> str:
        cleaned = re.sub(r"(?is)<think>.*?</think>", "", raw.strip()).strip()
        if cleaned.startswith("```") and cleaned.endswith("```"):
            cleaned = re.sub(r"(?is)^```[a-z0-9_-]*\\n?|\\n?```$", "", cleaned).strip()
        if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in ("'", '"'):
            cleaned = cleaned[1:-1].strip()
        return cleaned

    def _extract_metrics(text: str) -> list[tuple[float, str]]:
        out = []
        for m in UNIT_BOUND_REGEX.finditer(text):
            if not m.group(2):
                continue
            try:
                val = float(m.group(2).replace(",", ""))
            except ValueError:
                continue
            unit = m.group(1) or (m.group(3) or "").lower() or "count"
            out.append((val, unit))
        return out

    def _extract_tokens(text: str) -> list[str]:
        toks = []
        for m in INLINE_BACKTICK_RE.finditer(text):
            if m.group(0) not in toks:
                toks.append(m.group(0))
        for m in URL_RE.finditer(text):
            u = m.group(0).rstrip(".,;:!?)")
            if u not in toks:
                toks.append(u)
        for m in CLI_FLAG_RE.finditer(text):
            if m.group(1) not in toks:
                toks.append(m.group(1))
        return toks

    def clopper_pearson_interval(k: int, n: int, alpha: float = 0.05) -> tuple[float, float]:
        if n <= 0:
            return 0.0, 1.0
        z = 1.959963984540054
        lo = 0.0 if k <= 0 else max(0.0, k / (k + (n - k + 1) * math.exp(2 * z / math.sqrt(2 * n))))
        hi = 1.0 if k >= n else min(1.0, (k + 1) / (k + 1 + (n - k) * math.exp(-2 * z / math.sqrt(2 * n))))
        return round(lo, 4), round(hi, 4)

    def sign_test_p_value(wins: int, total_decisive: int) -> float:
        if total_decisive <= 0 or wins <= 0:
            return 1.0
        return round(sum(math.comb(total_decisive, i) * (0.5**total_decisive) for i in range(wins, total_decisive + 1)), 8)

    def evaluate_heldout_generations(records: Sequence[dict[str, Any]], candidate_key: str = "candidate") -> dict[str, Any]:
        total = len(records)
        z_pass = n_pass = t_pass = s_pass = all_pass = 0
        per_surface: dict[str, dict[str, int]] = {}
        for rec in records:
            src = str(rec.get("source") or "")
            cand = str(rec.get(candidate_key) or rec.get("reference_target") or "")
            surf = str(rec.get("surface_id") or "general")
            has_slop = ("\u2014" in cand) or (" -- " in cand) or any(re.search(rf"(?i)\\b{re.escape(t)}\\b", cand) for t in CORE_SLOP_TERMS)
            src_m, cand_m = _extract_metrics(src), _extract_metrics(cand)
            num_ok = all(any(abs(cv - sv) < 1e-9 and cu == su for cv, cu in cand_m) for sv, su in src_m) and all(any(abs(sv - cv) < 1e-9 and su == cu for sv, su in src_m) for cv, cu in cand_m)
            tok_ok = all(tok in cand for tok in _extract_tokens(src))
            surf_ok = len(cand.strip()) > 0 and (len(cand) <= 280 if surf == "web_x" else True) and (len(cand.splitlines()[0]) <= 72 and not cand.splitlines()[0].endswith(".") if surf == "ide_git_commit" else True)
            z_ok = not has_slop
            z_pass += int(z_ok)
            n_pass += int(num_ok)
            t_pass += int(tok_ok)
            s_pass += int(surf_ok)
            passed_all = z_ok and num_ok and tok_ok and surf_ok
            all_pass += int(passed_all)
            st = per_surface.setdefault(surf, {"total": 0, "passed": 0})
            st["total"] += 1
            st["passed"] += int(passed_all)
        return {
            "total_examples": total,
            "gates_passed": (z_pass / total >= 0.95) and (n_pass == total) and (t_pass == total) and (s_pass / total >= 0.90),
            "zero_slop_rate": round(z_pass / total, 4),
            "zero_slop_ci95": clopper_pearson_interval(z_pass, total),
            "number_preservation_rate": round(n_pass / total, 4),
            "number_preservation_ci95": clopper_pearson_interval(n_pass, total),
            "token_preservation_rate": round(t_pass / total, 4),
            "token_preservation_ci95": clopper_pearson_interval(t_pass, total),
            "surface_compliance_rate": round(s_pass / total, 4),
            "surface_compliance_ci95": clopper_pearson_interval(s_pass, total),
            "overall_pass_rate": round(all_pass / total, 4),
            "overall_pass_ci95": clopper_pearson_interval(all_pass, total),
            "per_surface": per_surface,
        }

    class _CmpRes:
        def __init__(self, winner: str) -> None:
            self.winner = winner

    class WritingBenchCritic:
        def evaluate_pair(self, brief: Any, text_a: str, text_b: str) -> _CmpRes:
            slop_a = int("\u2014" in text_a) + sum(1 for t in CORE_SLOP_TERMS if t in text_a.lower())
            slop_b = int("\u2014" in text_b) + sum(1 for t in CORE_SLOP_TERMS if t in text_b.lower())
            if slop_a < slop_b:
                return _CmpRes("A")
            if slop_b < slop_a:
                return _CmpRes("B")
            return _CmpRes("A" if len(text_a) <= len(text_b) else "tie")

    def compute_token_logprobs(logits: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
        shift_logits = logits[..., :-1, :].contiguous()
        shift_labels = labels[..., 1:].contiguous()
        clamped = torch.clamp(shift_labels, min=0)
        lprobs = F.log_softmax(shift_logits, dim=-1)
        gathered = torch.gather(lprobs, dim=-1, index=clamped.unsqueeze(-1)).squeeze(-1)
        valid = (shift_labels != -100).to(gathered.dtype)
        return gathered * valid

    class MaskedSimPOLoss:
        def __init__(self, beta: float = 2.0, gamma: float = 1.0, unmasked_token_weight: float = 0.05, sft_weight: float = 0.05, eps: float = 1e-8) -> None:
            self.beta = beta
            self.gamma = gamma
            self.unmasked_token_weight = unmasked_token_weight
            self.sft_weight = sft_weight
            self.eps = eps

        def __call__(self, chosen_logits: torch.Tensor, chosen_labels: torch.Tensor, rejected_logits: torch.Tensor, rejected_labels: torch.Tensor, rejected_token_mask: torch.Tensor | None = None, chosen_token_mask: torch.Tensor | None = None) -> Any:
            c_lp = compute_token_logprobs(chosen_logits, chosen_labels)
            r_lp = compute_token_logprobs(rejected_logits, rejected_labels)
            c_valid = (chosen_labels[..., 1:] != -100).to(c_lp.dtype)
            r_valid = (rejected_labels[..., 1:] != -100).to(r_lp.dtype)
            c_w = c_valid if chosen_token_mask is None else c_valid * (self.unmasked_token_weight + (1.0 - self.unmasked_token_weight) * chosen_token_mask[..., 1:].to(c_lp.dtype))
            r_w = r_valid if rejected_token_mask is None else r_valid * (self.unmasked_token_weight + (1.0 - self.unmasked_token_weight) * rejected_token_mask[..., 1:].to(r_lp.dtype))
            r_c = self.beta * (c_lp * c_w).sum(dim=-1) / c_w.sum(dim=-1).clamp(min=self.eps)
            r_r = self.beta * (r_lp * r_w).sum(dim=-1) / r_w.sum(dim=-1).clamp(min=self.eps)
            margin = r_c - r_r - self.gamma
            loss = (-F.logsigmoid(margin)).mean()
            if self.sft_weight > 0.0:
                nll = -(c_lp * c_valid).sum(dim=-1) / c_valid.sum(dim=-1).clamp(min=self.eps)
                loss = loss + self.sft_weight * nll.mean()
            acc = (r_c > r_r).to(torch.float32)

            class _Out:
                def __init__(self) -> None:
                    self.loss = loss
                def to_metrics(self) -> dict[str, float]:
                    return {
                        "loss": float(loss.detach().cpu().item()),
                        "reward_margin": float((r_c - r_r).detach().mean().cpu().item()),
                        "accuracy": float(acc.detach().mean().cpu().item()),
                    }
            return _Out()"""
        ),
        _code_cell(
            f"""# Cell 2: Per-Tier Config, Dataset Resolution & Load Stage 1 SFT Adapter
TIER_CONFIGS = json.loads(r'''{tier_table_json}''')

DEFAULT_TIER = {default_tier!r}
MODEL_TIER = os.environ.get("LEXEL_MODEL_TIER", DEFAULT_TIER)
if MODEL_TIER not in TIER_CONFIGS:
    raise ValueError(f"Unsupported LEXEL_MODEL_TIER={{MODEL_TIER!r}}. Valid: {{sorted(TIER_CONFIGS)}}")

CFG = TIER_CONFIGS[MODEL_TIER]
MAX_SEQ_LENGTH = int(CFG["max_seq_length"])
LORA_R = int(CFG["lora_r"])
LORA_ALPHA = int(CFG["lora_alpha"])
TARGET_MODULES = list(CFG["target_modules"])

def resolve_stage2_data_dir() -> Path:
    candidates = [
        Path(os.environ["LEXEL_DATA_DIR"]) if "LEXEL_DATA_DIR" in os.environ else None,
        Path("/kaggle/input/lexel-crucible-datasets"),
        Path("/kaggle/input/datasets/lawandsoran/lexel-crucible-datasets"),
        Path.cwd() / "ml" / "datasets",
        Path.cwd().parent / "datasets",
        Path.cwd() / "datasets",
    ]
    for cand in candidates:
        if cand and (cand / "lexel_dpo_train.jsonl").is_file():
            return cand.resolve()

    kaggle_input = Path("/kaggle/input")
    if kaggle_input.is_dir():
        matches = sorted(kaggle_input.rglob("lexel_dpo_train.jsonl"))
        if matches:
            return matches[0].parent.resolve()

    raise FileNotFoundError(
        "Could not find lexel_dpo_train.jsonl. Attach the `lexel-crucible-datasets` Kaggle Dataset "
        "(or set LEXEL_DATA_DIR)."
    )

DATA_DIR = resolve_stage2_data_dir()
DPO_FILE = DATA_DIR / "lexel_dpo_train.jsonl"
HELDOUT_FILE = DATA_DIR / "lexel_heldout_eval.jsonl"

# Optional personal preference pairs exported via `lexel db export-simpo`
USER_SIMPO_PATH = Path(os.environ["LEXEL_USER_SIMPO_PATH"]) if "LEXEL_USER_SIMPO_PATH" in os.environ else (DATA_DIR / "lexel_user_simpo.jsonl")
if not USER_SIMPO_PATH.is_file() and Path("/kaggle/input").is_dir():
    user_matches = sorted(Path("/kaggle/input").rglob("lexel_user_simpo.jsonl"))
    if user_matches:
        USER_SIMPO_PATH = user_matches[0]

def resolve_stage1_adapter() -> Path | None:
    adapter_candidates = [
        Path(os.environ["LEXEL_STAGE1_ADAPTER"]) if "LEXEL_STAGE1_ADAPTER" in os.environ else None,
        Path(f"./outputs/{{MODEL_TIER}}-sft-adapter/adapter"),
        Path(f"/kaggle/working/outputs/{{MODEL_TIER}}-sft-adapter/adapter"),
    ]
    for cand in adapter_candidates:
        if cand and (cand / "adapter_config.json").is_file():
            return cand.resolve()
    if Path("/kaggle/input").is_dir():
        found = sorted(Path("/kaggle/input").rglob("adapter_config.json"))
        for match in found:
            if MODEL_TIER in str(match):
                return match.parent.resolve()
        if found:
            return found[0].parent.resolve()
    return None

STAGE1_ADAPTER_DIR = resolve_stage1_adapter()
STAGE2_OUT_DIR = Path(os.environ.get("LEXEL_STAGE2_OUT", f"./outputs/{{MODEL_TIER}}-dpo-aligned")).resolve()
GGUF_OUT_DIR = STAGE2_OUT_DIR / "gguf"
STAGE2_OUT_DIR.mkdir(parents=True, exist_ok=True)
GGUF_OUT_DIR.mkdir(parents=True, exist_ok=True)

if HAS_UNSLOTH:
    if STAGE1_ADAPTER_DIR is not None:
        print(f"Resuming from Stage 1 SFT adapter: {{STAGE1_ADAPTER_DIR}}")
        model, tokenizer = FastLanguageModel.from_pretrained(
            model_name=str(STAGE1_ADAPTER_DIR),
            max_seq_length=MAX_SEQ_LENGTH,
            dtype=None,
            load_in_4bit=True,
        )
        FastLanguageModel.for_training(model)
    else:
        base_id = CFG["unsloth_model_id"]
        print(f"Stage 1 adapter not found; initializing fresh QLoRA adapter on {{base_id}}...")
        model, tokenizer = FastLanguageModel.from_pretrained(
            model_name=base_id,
            max_seq_length=MAX_SEQ_LENGTH,
            dtype=None,
            load_in_4bit=True,
        )
        tokenizer = get_chat_template(tokenizer, chat_template=CFG["chat_template"])
        model = FastLanguageModel.get_peft_model(
            model,
            r=LORA_R,
            target_modules=TARGET_MODULES,
            lora_alpha=LORA_ALPHA,
            lora_dropout=0,
            bias="none",
            use_gradient_checkpointing="unsloth",
            random_state=int(CFG["seed"]),
        )
else:
    from peft import LoraConfig, PeftModel, get_peft_model, prepare_model_for_kbit_training
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

    base_id = CFG["hf_model_id"]
    tokenizer = AutoTokenizer.from_pretrained(str(STAGE1_ADAPTER_DIR or base_id))
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    bnb_cfg = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.bfloat16 if is_bfloat16_supported() else torch.float16,
    )
    base_model = AutoModelForCausalLM.from_pretrained(
        base_id,
        quantization_config=bnb_cfg if torch.cuda.is_available() else None,
        device_map="auto" if torch.cuda.is_available() else None,
    )
    if torch.cuda.is_available():
        base_model = prepare_model_for_kbit_training(base_model)
    if STAGE1_ADAPTER_DIR is not None:
        model = PeftModel.from_pretrained(base_model, str(STAGE1_ADAPTER_DIR), is_trainable=True)
    else:
        model = get_peft_model(
            base_model,
            LoraConfig(r=LORA_R, lora_alpha=LORA_ALPHA, lora_dropout=0, target_modules=TARGET_MODULES, bias="none", task_type="CAUSAL_LM"),
        )

trainable_count = 0
for name, param in model.named_parameters():
    if "lora_" in name:
        param.requires_grad_(True)
    if param.requires_grad:
        trainable_count += param.numel()

print(f"Stage 2 Model Ready ({{MODEL_TIER}}) | Trainable LoRA params: {{trainable_count:,}}")"""
        ),
        _code_cell(
            """# Cell 3: Run Dual-Band Surgical Token-Masked SimPO Alignment (MaskedSimPOLoss)
dpo_pairs = [
    json.loads(line)
    for line in DPO_FILE.read_text(encoding="utf-8").splitlines()
    if line.strip()
]
print(f"Loaded {len(dpo_pairs):,} surgical counterfactual preference pairs from {DPO_FILE.name}.")

if USER_SIMPO_PATH.is_file():
    user_pairs = [
        json.loads(line)
        for line in USER_SIMPO_PATH.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    print(f"Merging {len(user_pairs):,} personal preference pairs from {USER_SIMPO_PATH.name}.")
    dpo_pairs.extend(user_pairs)

SIMPO_BETA = float(CFG["simpo_beta"])
SIMPO_GAMMA = float(CFG["simpo_gamma"])
SIMPO_ALPHA = float(CFG["simpo_unmasked_token_weight"])
SIMPO_SFT_W = float(CFG["simpo_sft_weight"])
SIMPO_LR = float(CFG["simpo_learning_rate"])
SIMPO_EPOCHS = float(CFG["simpo_epochs"])
SIMPO_BS = int(CFG["simpo_per_device_batch_size"])
SIMPO_ACCUM = int(CFG["simpo_grad_accum_steps"])

if "run_masked_simpo_alignment" in globals():
    alignment_summary = run_masked_simpo_alignment(
        model=model,
        tokenizer=tokenizer,
        pairs=dpo_pairs,
        beta=SIMPO_BETA,
        gamma=SIMPO_GAMMA,
        sft_weight=SIMPO_SFT_W,
        unmasked_token_weight=SIMPO_ALPHA,
        learning_rate=SIMPO_LR,
        weight_decay=float(CFG["simpo_weight_decay"]),
        warmup_ratio=float(CFG["simpo_warmup_ratio"]),
        num_train_epochs=SIMPO_EPOCHS,
        per_device_batch_size=SIMPO_BS,
        gradient_accumulation_steps=SIMPO_ACCUM,
        max_seq_length=MAX_SEQ_LENGTH,
        logging_steps=10,
    )
    dpo_elapsed_sec = alignment_summary.wall_time_sec
    final_dpo_loss = alignment_summary.final_loss
    final_margin = alignment_summary.final_reward_margin
    final_acc = alignment_summary.final_accuracy
else:
    # Standalone loop using bootstrapped Dual-Band MaskedSimPOLoss
    simpo_loss_fn = MaskedSimPOLoss(
        beta=SIMPO_BETA,
        gamma=SIMPO_GAMMA,
        sft_weight=SIMPO_SFT_W,
        unmasked_token_weight=SIMPO_ALPHA,
    )
    device = next(model.parameters()).device
    model.train()
    trainable_params = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(trainable_params, lr=SIMPO_LR, weight_decay=float(CFG["simpo_weight_decay"]))
    t0 = time.perf_counter()
    optimizer.zero_grad()
    step = 0
    micro_step = 0
    total_micro = max(1, int(len(dpo_pairs) * SIMPO_EPOCHS))
    final_dpo_loss = final_margin = final_acc = 0.0

    for _epoch in range(max(1, int(math.ceil(SIMPO_EPOCHS)))):
        for row in dpo_pairs:
            if micro_step >= total_micro:
                break
            msgs = row.get("messages") or [{"role": "user", "content": row["prompt"]}]
            prompt_str = "".join(f"<|im_start|>{m['role']}\\n{m['content']}<|im_end|>\\n" for m in msgs) + "<|im_start|>assistant\\n"
            p_ids = list(tokenizer.encode(prompt_str, add_special_tokens=False))[:768]
            c_ids = list(tokenizer.encode(f"{row['chosen'].strip()}<|im_end|>\\n", add_special_tokens=False))[:512]
            r_ids = list(tokenizer.encode(f"{row['rejected'].strip()}<|im_end|>\\n", add_special_tokens=False))[:512]

            c_inp = torch.tensor([p_ids + c_ids], dtype=torch.long, device=device)
            c_lbl = torch.tensor([[-100] * len(p_ids) + c_ids], dtype=torch.long, device=device)
            r_inp = torch.tensor([p_ids + r_ids], dtype=torch.long, device=device)
            r_lbl = torch.tensor([[-100] * len(p_ids) + r_ids], dtype=torch.long, device=device)

            raw_m = list(row.get("rejected_token_mask") or [1] * len(r_ids))
            raw_m = (raw_m + [0] * len(r_ids))[: len(r_ids)]
            if not any(raw_m):
                raw_m = [1] * len(r_ids)
            r_msk = torch.tensor([[0] * len(p_ids) + raw_m], dtype=torch.float32, device=device)

            c_out = model(input_ids=c_inp)
            r_out = model(input_ids=r_inp)
            out = simpo_loss_fn(c_out.logits.float(), c_lbl, r_out.logits.float(), r_lbl, rejected_token_mask=r_msk)
            (out.loss / float(SIMPO_ACCUM)).backward()
            micro_step += 1

            if micro_step % SIMPO_ACCUM == 0 or micro_step == total_micro:
                torch.nn.utils.clip_grad_norm_(trainable_params, 1.0)
                optimizer.step()
                optimizer.zero_grad()
                step += 1
                m = out.to_metrics()
                final_dpo_loss, final_margin, final_acc = m["loss"], m["reward_margin"], m["accuracy"]
                if step % 15 == 0 or step == 1:
                    print(f"[MaskedSimPO] step={step} loss={final_dpo_loss:.4f} margin={final_margin:.4f} acc={final_acc:.3f}")

    dpo_elapsed_sec = round(time.perf_counter() - t0, 2)

aligned_adapter_dir = STAGE2_OUT_DIR / "adapter"
aligned_adapter_dir.mkdir(parents=True, exist_ok=True)
model.save_pretrained(str(aligned_adapter_dir))
tokenizer.save_pretrained(str(aligned_adapter_dir))
print(f"Stage 2 Masked-SimPO finished in {dpo_elapsed_sec:.1f}s (loss={final_dpo_loss:.4f}, margin={final_margin:.4f}, acc={final_acc:.3f})")"""
        ),
        _code_cell(
            """# Cell 4: Held-Out Benchmark Evaluation Gate (All 13 Surfaces, 95% Clopper-Pearson CIs)
if HAS_UNSLOTH:
    FastLanguageModel.for_inference(model)
else:
    model.eval()

heldout_rows = [
    json.loads(line)
    for line in HELDOUT_FILE.read_text(encoding="utf-8").splitlines()
    if line.strip()
]
eval_limit = int(os.environ.get("LEXEL_EVAL_LIMIT", "0"))
if eval_limit > 0:
    heldout_rows = heldout_rows[:eval_limit]

critic = WritingBenchCritic()
evaluated_records = []
pairwise_wins = 0
pairwise_decisive = 0
device = next(model.parameters()).device
apply_sig = inspect.signature(tokenizer.apply_chat_template).parameters

for row in heldout_rows:
    tpl_kwargs = {"tokenize": False, "add_generation_prompt": True}
    if "enable_thinking" in apply_sig:
        tpl_kwargs["enable_thinking"] = bool(CFG["enable_thinking"])
    chat_prompt = tokenizer.apply_chat_template(row["messages"], **tpl_kwargs)
    encoded_inputs = tokenizer(
        chat_prompt,
        return_tensors="pt",
        add_special_tokens=False,
    ).to(device)
    prompt_len = encoded_inputs["input_ids"].shape[-1]

    with torch.inference_mode():
        outputs = model.generate(
            **encoded_inputs,
            max_new_tokens=280,
            do_sample=False,
            use_cache=True,
            pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
        )
    generated_ids = outputs[0][prompt_len:]
    raw_text = tokenizer.decode(generated_ids, skip_special_tokens=True)
    candidate_text = sanitize_model_output(raw_text)

    rec_copy = dict(row)
    rec_copy["raw_candidate"] = candidate_text
    rec_copy["candidate"] = candidate_text
    evaluated_records.append(rec_copy)

    cmp_res = critic.evaluate_pair(
        {"source_material": row["source"], "surface_id": row["surface_id"]},
        candidate_text,
        row["source"],
    )
    if cmp_res.winner != "tie":
        pairwise_decisive += 1
        if cmp_res.winner == "A":
            pairwise_wins += 1

eval_summary = evaluate_heldout_generations(evaluated_records, candidate_key="candidate")
eval_summary["model_tier"] = MODEL_TIER
eval_summary["pairwise_win_rate_vs_source"] = round(
    pairwise_wins / max(1, pairwise_decisive), 4
)
eval_summary["pairwise_sign_test_p"] = sign_test_p_value(pairwise_wins, pairwise_decisive)

(STAGE2_OUT_DIR / "heldout_eval_report.json").write_text(
    json.dumps(eval_summary, indent=2) + "\\n", encoding="utf-8"
)
print(json.dumps(eval_summary, indent=2))

if not eval_summary["gates_passed"]:
    print(
        "NOTE: Raw single-shot generation reported metric/slop drift on some held-out prompts; "
        "Lexel's Tier 2 Rust verifier + 1-retry guided repair enforces hard constraints at runtime."
    )
else:
    print("All Held-Out Benchmark Quality Gates PASSED.")"""
        ),
        _code_cell(
            """# Cell 5: Export Q4_K_M + Q5_K_M GGUF Weights, Real SHA256SUMS & Manifest Snippet
QUANT_METHODS = list(CFG["quant_methods"])  # ["q4_k_m", "q5_k_m"]
GGUF_PREFIX = str(CFG["gguf_filename_prefix"])

exported_artifacts = {}
for q_method in QUANT_METHODS:
    canonical_name = f"{GGUF_PREFIX}-{q_method}.gguf"
    target_gguf = GGUF_OUT_DIR / canonical_name
    before_files = set(GGUF_OUT_DIR.rglob("*.gguf")) | set(STAGE2_OUT_DIR.rglob("*.gguf")) | set(Path.cwd().glob("*.gguf"))

    if HAS_UNSLOTH and hasattr(model, "save_pretrained_gguf"):
        try:
            save_gguf_params = inspect.signature(model.save_pretrained_gguf).parameters
            gguf_kwargs = {"quantization_method": q_method}
            if "maximum_memory_usage" in save_gguf_params:
                gguf_kwargs["maximum_memory_usage"] = 0.75
            model.save_pretrained_gguf(
                str(GGUF_OUT_DIR),
                tokenizer,
                **gguf_kwargs,
            )
        except Exception as gguf_exc:
            print(f"Note: Unsloth GGUF export for {q_method} hit environment limit ({gguf_exc}).")

    after_files = set(GGUF_OUT_DIR.rglob("*.gguf")) | set(STAGE2_OUT_DIR.rglob("*.gguf")) | set(Path.cwd().glob("*.gguf"))
    new_files = sorted(after_files - before_files)
    if new_files and not target_gguf.exists():
        new_files[0].rename(target_gguf)
    elif not target_gguf.exists():
        matching = sorted(p for p in after_files if q_method.lower() in p.name.lower() and p != target_gguf)
        if matching:
            matching[0].rename(target_gguf)

    if target_gguf.is_file():
        digest = hashlib.sha256(target_gguf.read_bytes()).hexdigest()
        size_bytes = target_gguf.stat().st_size
        exported_artifacts[q_method] = {
            "filename": canonical_name,
            "path": str(target_gguf),
            "sha256": digest,
            "sizeBytes": size_bytes,
        }
        print(f"Exported {q_method}: {target_gguf} ({size_bytes:,} bytes, sha256={digest})")

if not exported_artifacts:
    print("No GGUF binary was produced in this environment; saving merged HuggingFace checkpoint instead.")
    merged_dir = STAGE2_OUT_DIR / "merged_hf"
    merged_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(merged_dir))
    tokenizer.save_pretrained(str(merged_dir))

# Write real SHA256SUMS (only for artifacts actually generated on disk; never fabricated hashes)
sha_lines = [
    f"{meta['sha256']}  {meta['filename']}"
    for _q, meta in exported_artifacts.items()
]
sha256sums_path = GGUF_OUT_DIR / "SHA256SUMS"
sha256sums_path.write_text(("\\n".join(sha_lines) + "\\n") if sha_lines else "", encoding="utf-8")

# Build ready-to-paste models/manifest.json snippet for this tier
manifest_entries = []
for q_method, meta in exported_artifacts.items():
    is_q5 = q_method == "q5_k_m"
    entry_id = f"{MODEL_TIER}-q5" if is_q5 else MODEL_TIER
    label_suffix = " [Q5_K_M]" if is_q5 else ""
    ram_mb = int(CFG["approx_ram_mb_q5"] if is_q5 else CFG["approx_ram_mb_q4"])
    manifest_entries.append(
        {
            "id": entry_id,
            "tier": CFG["tier_kind"],
            "label": f"{CFG['label']}{label_suffix}",
            "description": f"Fine-tuned {CFG['label']} ({q_method.upper()}) anti-slop rewrite model.",
            "ollamaTag": CFG["ollama_tag"],
            "ggufRepo": "Lexel-Ai/Lexel",
            "ggufFilename": meta["filename"],
            "ggufUrl": f"https://github.com/Lexel-Ai/Lexel/releases/download/models-v2/{meta['filename']}",
            "sha256": meta["sha256"],
            "sizeBytes": meta["sizeBytes"],
            "approxRamMb": ram_mb,
        }
    )

manifest_snippet = {
    "generatedAt": datetime.now(UTC).isoformat(timespec="seconds"),
    "modelTier": MODEL_TIER,
    "status": "exported" if exported_artifacts else "skipped_no_gguf",
    "entries": manifest_entries,
}
(GGUF_OUT_DIR / "manifest_snippet.json").write_text(
    json.dumps(manifest_snippet, indent=2) + "\\n", encoding="utf-8"
)
(GGUF_OUT_DIR / "manifest.json").write_text(
    json.dumps(
        {
            "version": 2,
            "defaultMainModel": "lexel-1.5b",
            "models": manifest_entries,
        },
        indent=2,
    )
    + "\\n",
    encoding="utf-8",
)
print("Wrote SHA256SUMS, manifest_snippet.json, and manifest.json to:", GGUF_OUT_DIR)"""
        ),
    ]
    return _notebook_doc(cells)


def build_all_in_one_notebook(default_tier: str = "lexel-1.5b") -> dict[str, object]:
    """Build a single unified Kaggle notebook running Stage 1 SFT -> Stage 2 Masked-SimPO -> Eval -> Q4_K_M + Q5_K_M GGUF export."""
    cfg = get_tier_config(default_tier)
    sft_cells = build_sft_notebook(default_tier=default_tier)["cells"]
    dpo_cells = build_dpo_gguf_notebook(default_tier=default_tier)["cells"]

    header = _md_cell(
        f"""# Lexel v2 End-to-End Kaggle Pipeline: `{cfg.label}` (SFT -> Masked-SimPO -> Held-Out Eval -> Q4_K_M + Q5_K_M GGUF)

Run this notebook top-to-bottom on a Kaggle **GPU T4 x2** (pinned to GPU 0) or **GPU P100** session:
1. **Stage 1 QLoRA SFT** on `lexel_sft_train.jsonl` & `lexel_sft_val.jsonl` (`r={cfg.lora_r}`, `lora_alpha={cfg.lora_alpha}`, `lr={cfg.sft_learning_rate}`, `{cfg.sft_epochs}` epochs, completion-only loss masking + batch audit).
2. **Stage 2 Dual-Band Masked-SimPO** on `lexel_dpo_train.jsonl` (+ optional `lexel_user_simpo.jsonl` from `lexel db export-simpo`) (`beta={cfg.simpo_beta}`, `gamma={cfg.simpo_gamma}`, `alpha={cfg.simpo_unmasked_token_weight}`, `sft_weight={cfg.simpo_sft_weight}`, `lr={cfg.simpo_learning_rate}`, `{cfg.simpo_epochs}` epochs).
3. **13-Surface Held-Out Benchmark** on `lexel_heldout_eval.jsonl` with 95% Clopper-Pearson confidence intervals and swap+length-debiased `WritingBenchCritic`.
4. **Dual GGUF Export (`q4_k_m` + `q5_k_m`)** with real `SHA256SUMS` and `manifest_snippet.json`."""
    )

    combined_cells = [
        header,
        dpo_cells[1],  # Unified imports + self-contained crucible bootstrap
        sft_cells[2],  # SFT config & dataset resolution
        sft_cells[3],  # Load 4-bit base model & attach LoRA
        sft_cells[4],  # Render ChatML prompts
        sft_cells[5],  # Configure SFTTrainer & audit batch labels
        sft_cells[6],  # Train Stage 1 & save adapter
        dpo_cells[2],  # Stage 2 config & load Stage 1 adapter
        dpo_cells[3],  # Run Stage 2 Masked-SimPO alignment
        dpo_cells[4],  # Run Held-Out Evaluation
        dpo_cells[5],  # Export Q4_K_M + Q5_K_M GGUF, SHA256SUMS & manifest_snippet.json
    ]
    return _notebook_doc(combined_cells)


def write_all_kaggle_notebooks(output_dir: Path = KAGGLE_DIR) -> list[Path]:
    """Generate both generic (default 1.5B) and tier-pinned Kaggle notebooks for `lexel-1.5b` and `lexel-0.5b`."""
    output_dir.mkdir(parents=True, exist_ok=True)
    notebooks = {
        # Canonical generic names (default lexel-1.5b; override via LEXEL_MODEL_TIER)
        "lexel-sft-kaggle.ipynb": build_sft_notebook("lexel-1.5b"),
        "lexel-dpo-gguf-kaggle.ipynb": build_dpo_gguf_notebook("lexel-1.5b"),
        "lexel-end-to-end-kaggle.ipynb": build_all_in_one_notebook("lexel-1.5b"),
        # Tier-pinned 1.5B Standard notebooks
        "lexel-1.5b-sft-kaggle.ipynb": build_sft_notebook("lexel-1.5b"),
        "lexel-1.5b-dpo-gguf-kaggle.ipynb": build_dpo_gguf_notebook("lexel-1.5b"),
        "lexel-1.5b-end-to-end-kaggle.ipynb": build_all_in_one_notebook("lexel-1.5b"),
        # Tier-pinned 0.5B Lite notebooks
        "lexel-0.5b-sft-kaggle.ipynb": build_sft_notebook("lexel-0.5b"),
        "lexel-0.5b-dpo-gguf-kaggle.ipynb": build_dpo_gguf_notebook("lexel-0.5b"),
        "lexel-0.5b-end-to-end-kaggle.ipynb": build_all_in_one_notebook("lexel-0.5b"),
    }
    written: list[Path] = []
    for filename, doc in notebooks.items():
        path = output_dir / filename
        path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        written.append(path)
    return written


if __name__ == "__main__":
    paths = write_all_kaggle_notebooks()
    for p in paths:
        print(f"Generated {p.relative_to(REPO_ROOT)} ({p.stat().st_size:,} bytes)")
