# Lexel QLoRA SFT, Masked-SimPO Alignment & GGUF Export Guide

This directory contains the reproducible two-stage training and GGUF quantization workflow for **Lexel** (`Qwen2.5-1.5B-Instruct` Standard tier and `Qwen2.5-0.5B-Instruct` Lite tier).

---

## 1. Preflight Dataset Verification (Offline CPU)

Before starting a GPU training run, build and verify the Crucible-filtered datasets locally:

```bash
python3 -m ml.crucible.dataset_builder
python3 .agents/skills/unsloth/scripts/unsloth_preflight.py dataset \
  ml/datasets/lexel_sft_train.jsonl \
  --eval-file ml/datasets/lexel_sft_val.jsonl \
  --json
uv run pytest
```

Confirm that:
- `ok: true`, `issue_count: 0`, and `overlap_unique_rows: 0` in the preflight JSON output.
- All 6 Data Crucible gates (`ZeroSlopGate`, `NumericAndTokenGroundingGate`, `SurfaceComplianceGate`, `ActiveVerbAndDirectnessGate`, `LexicalDensityAndBurstinessGate`, `IntegrityAndLeakageGate`) report 100% pass rate on the final splits in `ml/datasets/manifest.json`.

---

## 2. Training in Unsloth Studio Desktop (`~/.local/bin/unsloth-studio`)

1. Launch Unsloth Studio Desktop on your local Linux workstation:
   ```bash
   ~/.local/bin/unsloth-studio
   ```
2. Open **Dataset Manager** and import:
   - Training split: `/home/lawand/Lexel/ml/datasets/lexel_sft_train.jsonl`
   - Validation split: `/home/lawand/Lexel/ml/datasets/lexel_sft_val.jsonl`
3. Configure Stage 1 QLoRA SFT parameters:
   - **Base Model**: `unsloth/Qwen2.5-1.5B-Instruct-bnb-4bit` (or `unsloth/Qwen2.5-0.5B-Instruct-bnb-4bit`)
   - **LoRA Rank / Alpha / Dropout**: `r = 32`, `lora_alpha = 64`, `lora_dropout = 0`
   - **Target Modules**: `q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj`
   - **Context & Packing**: `max_seq_length = 1536`, Sequence Packing enabled, `train_on_responses_only` enabled
   - **Optimizer & Schedule**: `adamw_8bit`, `lr = 2e-4`, `cosine` scheduler, `warmup_ratio = 0.05`, `2` epochs
4. Or run `ml/kaggle/lexel-sft-kaggle.ipynb` and `ml/kaggle/lexel-dpo-gguf-kaggle.ipynb` directly inside Unsloth Studio's Jupyter kernel.

---

## 3. Training on Kaggle Free Tier GPUs (`2x T4 16GB` or `P100`)

1. Upload the `ml/datasets/` folder (`lexel_sft_train.jsonl`, `lexel_sft_val.jsonl`, `lexel_dpo_train.jsonl`, `lexel_heldout_eval.jsonl`, `manifest.json`) as a private Kaggle Dataset named `lexel-crucible-datasets`.
2. Import `ml/kaggle/lexel-sft-kaggle.ipynb` into Kaggle Notebooks:
   - Set **Accelerator** to **GPU T4 x2**.
   - Set environment variable `LEXEL_DATA_DIR=/kaggle/input/lexel-crucible-datasets`.
   - Run all cells. Stage 1 finishes 2 packed epochs in ~12 minutes on T4 GPUs and saves `./outputs/lexel-1.5b-sft-adapter/adapter` and `run_manifest.json`.
3. Import `ml/kaggle/lexel-dpo-gguf-kaggle.ipynb`:
   - Attach the Stage 1 output directory.
   - Run Stage 2 preference alignment (`MaskedSimPOLoss` with `beta=2.0`, `gamma=1.0`, `sft_weight=0.05`, `unmasked_token_weight=0.05`, `lr=5e-6`, `1.5` epochs).
   - Cell 4 runs the deterministic 13-surface held-out benchmark gate on `lexel_heldout_eval.jsonl` (requiring Zero-Slop >= 95%, Number & Token Preservation == 100%, Surface Compliance >= 90%).
   - Cell 5 exports `qwen2.5-1.5b-instruct-q4_k_m.gguf` (or `qwen2.5-0.5b-instruct-q4_k_m.gguf`), `SHA256SUMS`, and `manifest.json`.

---

## 4. Loading the Exported `.gguf` into Lexel Desktop & Daemon

1. Copy the exported `.gguf` file into Lexel's local model directory:
   ```bash
   mkdir -p ~/.local/share/lexel/models
   cp outputs/lexel-1.5b-dpo-aligned/gguf/qwen2.5-1.5b-instruct-q4_k_m.gguf ~/.local/share/lexel/models/
   ```
2. Verify the SHA-256 checksum matches `SHA256SUMS`:
   ```bash
   sha256sum -c outputs/lexel-1.5b-dpo-aligned/gguf/SHA256SUMS
   ```
3. Update `/home/lawand/Lexel/models/manifest.json` with the new `sha256` and `sizeBytes` from `outputs/lexel-1.5b-dpo-aligned/gguf/manifest.json`.
4. Alternatively, import the GGUF into Ollama for local daemon testing:
   ```bash
   printf 'FROM ./qwen2.5-1.5b-instruct-q4_k_m.gguf\nPARAMETER temperature 0.3\nPARAMETER num_ctx 1536\n' > Modelfile
   ollama create qwen2.5:1.5b -f Modelfile
   ```
5. In **Lexel Desktop** -> **AI Models & Runtime**, select **Lexel 1.5B (Standard)** (or **Lexel 0.5B (Lite)**) and run a test rewrite in the Writing Lab. Every AI output is still checked at runtime by Lexel's Tier 2 deterministic verifier (`crates/lexel-core/src/verifier.rs`).
