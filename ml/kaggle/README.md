# Lexel v2 Training Pipeline: Kaggle Free Tier (2x T4 / P100) & Unsloth

This directory contains ready-to-run Kaggle notebooks for training **both Lexel model tiers** from the 6-Gate Crucible v2 datasets (`ml/datasets/`), plus an optional `Qwen3-1.7B` non-thinking bake-off configuration (`ml/configs/qwen3-1.7b-bakeoff.json`).

All training hyperparameters are justified in [ml/RESEARCH_NOTES.md](../RESEARCH_NOTES.md) and stored in machine-readable JSON under `ml/configs/`.

---

## 1. Per-Tier Notebooks & Hyperparameters

| Tier | Base Model (Unsloth 4-bit) | LoRA (`r` / `alpha`) | SFT (`lr` / epochs / eff BS) | Masked-SimPO (`beta` / `gamma` / `lr` / epochs) | GGUF Exports | Notebooks |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`lexel-1.5b` (Standard)** | `unsloth/Qwen2.5-1.5B-Instruct-bnb-4bit` | `32` / `64` (all 7 linears) | `2e-4` / `2.0` / `16` | `2.0` / `1.0` / `5e-6` / `1.5` | `q4_k_m` + `q5_k_m` | `lexel-1.5b-end-to-end-kaggle.ipynb`, `lexel-1.5b-sft-kaggle.ipynb`, `lexel-1.5b-dpo-gguf-kaggle.ipynb` |
| **`lexel-0.5b` (Lite)** | `unsloth/Qwen2.5-0.5B-Instruct-bnb-4bit` | `16` / `32` (all 7 linears) | `3e-4` / `2.0` / `16` | `2.0` / `0.8` / `8e-6` / `1.5` | `q4_k_m` + `q5_k_m` | `lexel-0.5b-end-to-end-kaggle.ipynb`, `lexel-0.5b-sft-kaggle.ipynb`, `lexel-0.5b-dpo-gguf-kaggle.ipynb` |
| **`qwen3-1.7b-bakeoff` (Optional)** | `unsloth/Qwen3-1.7B-unsloth-bnb-4bit` | `32` / `64` (all 7 linears) | `1.5e-4` / `2.0` / `16` | `2.0` / `1.0` / `4e-6` / `1.5` | `q4_k_m` + `q5_k_m` | Use `lexel-end-to-end-kaggle.ipynb` with `LEXEL_MODEL_TIER=qwen3-1.7b-bakeoff` |

Generic notebooks (`lexel-end-to-end-kaggle.ipynb`, `lexel-sft-kaggle.ipynb`, `lexel-dpo-gguf-kaggle.ipynb`) default to `lexel-1.5b` and respect `LEXEL_MODEL_TIER` (`lexel-1.5b`, `lexel-0.5b`, or `qwen3-1.7b-bakeoff`).

Shared settings across all tiers:
- **Context length**: `max_seq_length = 1536` (matching `lexel-daemon` `n_ctx = 1536`)
- **Completion-only loss masking**: `train_on_responses_only` on `<|im_start|>user\n` / `<|im_start|>assistant\n`, verified on a real collated batch (`supervised_count > 0`) before `.train()` starts
- **Dual-Band `MaskedSimPOLoss`**: `unmasked_token_weight = 0.05`, `sft_weight = 0.05` (focusing negative gradients on defect spans without inducing timidity)
- **Kaggle T4 safety**: Pins `CUDA_VISIBLE_DEVICES=0`, uses `adamw_8bit`, Unsloth gradient checkpointing, and `fp16` on T4 (SM 7.5) or `bf16` on Ampere+ GPUs

---

## 2. Local Dataset Generation & Preflight Audit

Rebuild the v2 Crucible datasets, per-tier JSON configs, and all Kaggle notebooks locally (zero GPU required):

```bash
uv run python -m ml.crucible.dataset_builder
uv run pytest
python3 .agents/skills/unsloth/scripts/unsloth_preflight.py dataset \
  ml/datasets/lexel_sft_train.jsonl \
  --eval-file ml/datasets/lexel_sft_val.jsonl \
  --json
```

Confirm `"ok": true` and `"overlap_unique_rows": 0`, and check `ml/datasets/manifest.json` for exact split counts, surface/task distributions, and zero 8-gram held-out leakage.

---

## 3. Step-by-Step Kaggle Free Tier Training (Both Tiers)

### Step A: Upload the Dataset (`lexel-crucible-datasets`)
Upload `ml/datasets/` (`lexel_sft_train.jsonl`, `lexel_sft_val.jsonl`, `lexel_dpo_train.jsonl`, `lexel_heldout_eval.jsonl`, `manifest.json`, `slop_terms.json`, `surfaces.json`, `dataset-metadata.json`) via the Kaggle UI (**Datasets -> New Dataset**) or CLI:

```bash
kaggle datasets create -p ml/datasets
# Or push a new version after regenerating v2 data:
kaggle datasets version -p ml/datasets -m "Lexel v2 scaled Crucible datasets"
```

*(Optional personal alignment)*: Export your real local edits and rejections as PII-scrubbed SimPO pairs and attach `lexel_user_simpo.jsonl` to the same dataset (or a private Kaggle dataset):

```bash
lexel db export-simpo --out lexel_user_simpo.jsonl
```

Stage 2 notebooks automatically detect `lexel_user_simpo.jsonl` anywhere under `/kaggle/input` and merge it into `dpo_pairs`.

### Step B: Train `lexel-1.5b` (Standard Tier)
Choose either **Option 1 (End-to-End, single session)** or **Option 2 (Split SFT -> SimPO+GGUF)**:

1. Open **Kaggle Notebooks -> New Notebook -> File -> Import Notebook**.
   - **Option 1 (Recommended for T4 x2)**: Import `ml/kaggle/lexel-1.5b-end-to-end-kaggle.ipynb`.
   - **Option 2 (Split sessions)**: Import `ml/kaggle/lexel-1.5b-sft-kaggle.ipynb` first, save its `./outputs/lexel-1.5b-sft-adapter/adapter` output as a Kaggle Dataset or Notebook Output, then import `ml/kaggle/lexel-1.5b-dpo-gguf-kaggle.ipynb` and attach both `lexel-crucible-datasets` and the Stage 1 adapter output.
2. In the Kaggle right sidebar:
   - **Accelerator**: **GPU T4 x2** (Cell 1 automatically pins `CUDA_VISIBLE_DEVICES=0` for bitsandbytes stability) or **GPU P100**.
   - **Internet**: **On** (required to install `unsloth` and download `unsloth/Qwen2.5-1.5B-Instruct-bnb-4bit`).
   - **Add Input**: Attach `lexel-crucible-datasets`.
3. Click **Run All**.
4. Download the output directory `./outputs/lexel-1.5b-dpo-aligned/`:
   - `heldout_eval_report.json` (13-surface held-out metrics + 95% Clopper-Pearson CIs)
   - `gguf/qwen2.5-1.5b-instruct-q4_k_m.gguf`
   - `gguf/qwen2.5-1.5b-instruct-q5_k_m.gguf`
   - `gguf/SHA256SUMS`
   - `gguf/manifest_snippet.json`

### Step C: Train `lexel-0.5b` (Lite Tier)
Repeat Step B using the 0.5B tier-pinned notebooks (no environment variables required):
- **End-to-End**: `ml/kaggle/lexel-0.5b-end-to-end-kaggle.ipynb`
- **Split**: `ml/kaggle/lexel-0.5b-sft-kaggle.ipynb` followed by `ml/kaggle/lexel-0.5b-dpo-gguf-kaggle.ipynb`

Download `./outputs/lexel-0.5b-dpo-aligned/`:
- `heldout_eval_report.json`
- `gguf/qwen2.5-0.5b-instruct-q4_k_m.gguf`
- `gguf/qwen2.5-0.5b-instruct-q5_k_m.gguf`
- `gguf/SHA256SUMS`
- `gguf/manifest_snippet.json`

### Step D (Optional): Qwen3-1.7B Non-Thinking Bake-Off
1. Import `ml/kaggle/lexel-end-to-end-kaggle.ipynb`.
2. Add `os.environ["LEXEL_MODEL_TIER"] = "qwen3-1.7b-bakeoff"` at the top of Cell 1.
3. Click **Run All**. The notebook loads `unsloth/Qwen3-1.7B-unsloth-bnb-4bit` with `enable_thinking=False` and exports `qwen3-1.7b-nonthinking-q4_k_m.gguf` and `qwen3-1.7b-nonthinking-q5_k_m.gguf` for head-to-head comparison against `lexel-1.5b` on the identical held-out suite.

---

## 4. Verify & Ship Exported GGUFs Locally

1. Verify SHA-256 checksums before moving files:
   ```bash
   (cd outputs/lexel-1.5b-dpo-aligned/gguf && sha256sum -c SHA256SUMS)
   (cd outputs/lexel-0.5b-dpo-aligned/gguf && sha256sum -c SHA256SUMS)
   ```
2. Copy the verified `.gguf` weights into Lexel's local model directory:
   ```bash
   mkdir -p ~/.local/share/lexel/models
   cp outputs/lexel-1.5b-dpo-aligned/gguf/qwen2.5-1.5b-instruct-q4_k_m.gguf ~/.local/share/lexel/models/
   cp outputs/lexel-0.5b-dpo-aligned/gguf/qwen2.5-0.5b-instruct-q4_k_m.gguf ~/.local/share/lexel/models/
   ```
3. Run the end-to-end local regression benchmark via `lexel bench` against the running `lexel-daemon`:
   ```bash
   lexel bench --eval ml/datasets/lexel_heldout_eval.jsonl
   ```
4. Once `lexel bench` confirms improvement over v1 (zero-slop rate, numeric/code-token preservation, surface pass rate, and CPU latency p50/p95), upload the GGUF release assets and paste the real `sha256` and `sizeBytes` from `gguf/manifest_snippet.json` into `models/manifest.json`. Never commit unverified or placeholder checksums to `models/manifest.json`.
