# Lexel QLoRA SFT, Masked-SimPO Alignment & GGUF Export Guide

This directory contains the reproducible, self-contained two-stage training and GGUF quantization workflow for **Lexel** (`Qwen2.5-1.5B-Instruct` Standard tier and `Qwen2.5-0.5B-Instruct` Lite tier).

---

## 1. Build Datasets & Kaggle Notebooks Locally (Offline CPU)

Run a single command to build the 6-Gate Crucible-filtered datasets (`ml/datasets/`), Kaggle Dataset metadata (`dataset-metadata.json`), and all three Kaggle Jupyter notebooks (`ml/kaggle/*.ipynb`):

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
- All three notebooks are generated in `ml/kaggle/`:
  - `ml/kaggle/lexel-end-to-end-kaggle.ipynb` (**Recommended**: single all-in-one notebook running Stage 1 SFT -> Stage 2 Masked-SimPO -> Held-Out Eval -> GGUF Export in one session).
  - `ml/kaggle/lexel-sft-kaggle.ipynb` (Stage 1 QLoRA SFT only).
  - `ml/kaggle/lexel-dpo-gguf-kaggle.ipynb` (Stage 2 Surgical Token-Masked SimPO + Held-Out Eval + GGUF Export).

---

## 2. Training on Kaggle Free Tier GPUs (`GPU T4 x2` or `P100`)

### Step A: Create Your Kaggle Dataset (`lexel-crucible-datasets`)
Upload the `ml/datasets/` folder (`lexel_sft_train.jsonl`, `lexel_sft_val.jsonl`, `lexel_dpo_train.jsonl`, `lexel_heldout_eval.jsonl`, `manifest.json`, `slop_terms.json`, `surfaces.json`, `dataset-metadata.json`) via the Kaggle Web UI (**Datasets -> New Dataset**) or the Kaggle CLI:

```bash
kaggle datasets create -p ml/datasets
```

### Step B: Import & Run the Notebook on Kaggle
1. Open **Kaggle Notebooks -> New Notebook -> File -> Import Notebook** and upload `ml/kaggle/lexel-end-to-end-kaggle.ipynb` (or run `lexel-sft-kaggle.ipynb` followed by `lexel-dpo-gguf-kaggle.ipynb`).
2. In the right sidebar:
   - Set **Accelerator** to **GPU T4 x2** (or **GPU P100**).
   - Enable **Internet** (so Cell 1 can install `unsloth` and download `unsloth/Qwen2.5-1.5B-Instruct-bnb-4bit`).
   - Click **Add Input** and attach your `lexel-crucible-datasets` dataset. (The notebook automatically discovers `lexel_sft_train.jsonl` and `lexel_dpo_train.jsonl` anywhere under `/kaggle/input` without needing manual environment variables.)
3. Click **Run All**.
   - **Cell 1** pins `CUDA_VISIBLE_DEVICES=0`, disables `wandb` interactive prompts, installs `unsloth` cleanly via `subprocess.check_call` (no `!pip` magic or `xformers` ABI conflicts), and bootstraps self-contained Crucible verifiers and `MaskedSimPOLoss`.
   - **Stage 1 Cells** inspect the installed `trl.SFTConfig` / `trl.SFTTrainer` signature (`processing_class` vs `tokenizer`, `max_length` vs `max_seq_length`), apply `train_on_responses_only` completion-only loss masking, verify supervised token counts on a real batch, and train for 2 epochs.
   - **Stage 2 Cells** run surgical token-masked preference alignment (`MaskedSimPOLoss` with `beta=2.0`, `gamma=1.0`, `sft_weight=0.05`, `unmasked_token_weight=0.05`, `lr=5e-6`, `1.5` epochs) focusing negative gradients strictly on hallucinated numbers, dropped code tokens, em dashes, and slop spans.
   - **Evaluation & Export Cells** evaluate all 13 surfaces on `lexel_heldout_eval.jsonl` and export `qwen2.5-1.5b-instruct-q4_k_m.gguf` (or `qwen2.5-0.5b-instruct-q4_k_m.gguf`), `SHA256SUMS`, and `manifest.json` under `./outputs/lexel-1.5b-dpo-aligned/gguf/`.

---

## 3. Training in Unsloth Studio Desktop (`~/.local/bin/unsloth-studio`)

1. Launch Unsloth Studio Desktop on your local Linux workstation:
   ```bash
   ~/.local/bin/unsloth-studio
   ```
2. Open `ml/kaggle/lexel-end-to-end-kaggle.ipynb` (or `lexel-sft-kaggle.ipynb` and `lexel-dpo-gguf-kaggle.ipynb`) directly inside Unsloth Studio's Jupyter kernel, or import `/home/lawand/Lexel/ml/datasets/lexel_sft_train.jsonl` and `/home/lawand/Lexel/ml/datasets/lexel_sft_val.jsonl` into Dataset Manager.

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
