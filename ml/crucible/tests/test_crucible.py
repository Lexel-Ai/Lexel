"""Comprehensive unit test suite for Lexel Data Crucible, SCM, Packing, Masked-SimPO, and Kaggle notebooks."""

from __future__ import annotations

import ast
import json
import subprocess
import sys
from pathlib import Path

import pytest

from ml.crucible.alignment import PreferenceBatchCollator
from ml.crucible.build_notebooks import write_all_kaggle_notebooks
from ml.crucible.collator import (
    PackedBatchCollator,
    PackingItem,
    pack_sequences_bfd,
    pack_sequences_ffd,
    pack_tokenized_dataset,
    tokenize_completion_only,
)
from ml.crucible.config import (
    ALL_SURFACE_IDS,
    ALL_TASK_IDS,
    REPO_ROOT,
    VoiceExample,
    build_rewrite_messages,
    build_rewrite_messages_with_surfaces,
    build_tagged_prompt_pair,
    load_slop_config,
    load_surface_catalog,
    select_relevant_voice_examples,
    task_instruction,
)
from ml.crucible.counterfactual import (
    PerturbationType,
    align_spans_to_token_mask,
    generate_surgical_counterfactual,
    inject_reverse_slop,
    perturb_code_token_drop,
    perturb_em_dash,
    perturb_entity,
    perturb_negation,
    perturb_numerical,
    perturb_slop,
    perturb_surface_violation,
)
from ml.crucible.crucible import (
    ActiveVerbAndDirectnessGate,
    DataCrucible,
    IntegrityAndLeakageGate,
    LexicalDensityAndBurstinessGate,
    NumericAndTokenGroundingGate,
    SurfaceComplianceGate,
    ZeroSlopGate,
)
from ml.crucible.evaluate import (
    JudgeCalibrator,
    WritingBenchCritic,
    clopper_pearson_interval,
    evaluate_heldout_generations,
    sign_test_p_value,
)
from ml.crucible.loss import (
    MaskedDPOLoss,
    MaskedSimPOLoss,
    compute_token_logprobs,
)
from ml.crucible.verifier import (
    extract_code_and_url_tokens,
    extract_unit_bound_metrics,
    sanitize_model_output,
    validate_surface_compliance,
    verify_rewrite,
)


def test_single_source_of_truth_loading() -> None:
    """Architecture Invariant #3: verify direct loading of rules/slop_terms.json and ml/personas/surfaces.json."""
    slop_cfg = load_slop_config()
    assert slop_cfg.version == 2
    assert slop_cfg.em_dash_forbidden is True
    assert "delve" in slop_cfg.slop_terms
    assert "tapestry" in slop_cfg.slop_terms
    assert "game-changer" in slop_cfg.slop_terms
    assert slop_cfg.safe_replacements["seamless"] == "smooth"
    assert len(slop_cfg.all_banned_terms) >= len(slop_cfg.slop_terms)

    surface_cat = load_surface_catalog()
    profiles = surface_cat.all()
    loaded_ids = tuple(p.id for p in profiles)
    assert len(profiles) == 13
    assert set(loaded_ids) == set(ALL_SURFACE_IDS)

    reddit = surface_cat.get("web_reddit")
    assert reddit.allow_links is False
    assert reddit.allow_emojis is False
    assert reddit.allow_em_dashes is False
    assert reddit.max_chars == 900

    fallback = surface_cat.get("nonexistent_surface_xyz")
    assert fallback.id == "general"


def test_prompt_builder_parity_with_lexel_core() -> None:
    """Verify build_rewrite_messages_with_surfaces matches crates/lexel-core/src/prompt.rs byte-for-byte."""
    examples = [
        VoiceExample(
            id="v1",
            profile_id="p1",
            surface_id="web_github_pr",
            subcontext="lexel-rs/lexel",
            original="Awesome work! Fixed #42.",
            rewritten="Fixes #42   with   unit-bound   metric checks.",
            action="accepted",
            created_at=100,
        ),
        VoiceExample(
            id="v2",
            profile_id="p1",
            surface_id="general",
            subcontext=None,
            original="General note.",
            rewritten="Keep every metric intact.",
            action="accepted",
            created_at=200,
        ),
    ]
    selected = select_relevant_voice_examples(
        examples,
        surface_id="web_github_pr",
        source_text="Check metric in #42",
        limit=2,
    )
    assert len(selected) == 2
    assert selected[0].id == "v1"

    msgs = build_rewrite_messages_with_surfaces(
        text="  Great job! This PR fixes #42 in `verifier.rs`.  ",
        task="deslop",
        surface_id="web_github_pr",
        subcontext="lexel-rs/lexel",
        thread_context="Please review the verifier changes.",
        voice_examples=examples,
    )
    assert len(msgs) == 2
    assert msgs[0].role == "system"
    assert msgs[1].role == "user"

    expected_system = "\n".join(
        [
            "You are Lexel, a precise human writing editor.",
            "Rules:",
            "- Output ONLY the rewritten text. No preamble, no quotes, no explanation.",
            "- Preserve every number, metric, ID (#42), URL, and `code` token exactly.",
            "- Never use em dashes (\u2014) or AI buzzwords (delve, tapestry, seamless, leverage, game-changer, unlock, pivotal).",
            "- Surface: GitHub (web_github_pr)",
            "- Subcontext: lexel-rs/lexel",
            "- Platform style: Write concisely for engineers reviewing code or issues. Preserve all backticks, file paths, issue IDs (#42), and metrics exactly. Remove sycophancy and fluff.",
            "- Max characters: 4000",
            "- Task: Remove AI buzzwords, corporate padding, filler openers, and em dashes. Make every sentence direct and human.",
            "<voice_examples>",
            "- Fixes #42 with unit-bound metric checks.",
            "- Keep every metric intact.",
            "</voice_examples>",
        ]
    )
    expected_user = (
        "<thread_context>\nPlease review the verifier changes.\n</thread_context>\n\n"
        "<source>\nGreat job! This PR fixes #42 in `verifier.rs`.\n</source>"
    )
    assert msgs[0].content == expected_system
    assert msgs[1].content == expected_user

    # Verify all 13 surfaces and 7 tasks build valid prompts and tagged prompt pairs
    for surf_id in ALL_SURFACE_IDS:
        for t_id in ALL_TASK_IDS:
            assert len(task_instruction(t_id)) > 10
            m = build_rewrite_messages("Sample draft #42.", t_id, surf_id)
            assert len(m) == 2
            tagged = build_tagged_prompt_pair(
                "Sample draft #42.",
                t_id,
                surf_id,
                subcontext="ctx",
                thread_context="tctx",
                voice_examples=examples,
            )
            for tag in (
                "<surface>",
                "<subcontext>",
                "<task>",
                "<surface_rules>",
                "<voice_examples>",
                "<thread_context>",
                "<source>",
            ):
                assert tag in tagged["tagged_prompt"]


def test_unit_bound_numeric_and_token_verifier() -> None:
    """Verify unit-bound metric extraction (#42 vs 42% vs 18ms vs $42 vs 42MB vs 16px) and code/URL/CLI-flag preservation."""
    sample = (
        "Fixes #42 by cutting p99 latency to 18ms, saving 42% RAM (42MB) "
        "and $42/month with a 16px icon via `lexel-core`, `--max-tokens`, and https://lexel.dev/docs."
    )
    metrics = extract_unit_bound_metrics(sample)
    units_by_raw = {(m.value, m.unit) for m in metrics}
    assert (42.0, "#") in units_by_raw
    assert (18.0, "ms") in units_by_raw
    assert (42.0, "%") in units_by_raw
    assert (42.0, "mb") in units_by_raw
    assert (42.0, "$") in units_by_raw
    assert (16.0, "px") in units_by_raw

    tokens = extract_code_and_url_tokens(sample)
    assert "`lexel-core`" in tokens
    assert "https://lexel.dev/docs" in tokens
    assert "--max-tokens" in tokens

    # Swapping #42 for 42% must fail unit-bound verification
    bad_unit_swap = (
        "Fixes 42% by cutting p99 latency to 18ms, saving 42% RAM (42MB) "
        "and $42/month with a 16px icon via `lexel-core`, `--max-tokens`, and https://lexel.dev/docs."
    )
    res_swap = verify_rewrite(sample, bad_unit_swap, "web_github_pr")
    assert res_swap.numbers_preserved is False

    # Dropping `--max-tokens` or `lexel-core` must fail token verification
    bad_token_drop = (
        "Fixes #42 by cutting p99 latency to 18ms, saving 42% RAM (42MB) "
        "and $42/month with a 16px icon via lexel-core and https://lexel.dev/docs."
    )
    res_drop = verify_rewrite(sample, bad_token_drop, "web_github_pr")
    assert res_drop.tokens_preserved is False
    assert "`lexel-core`" in res_drop.missing_tokens
    assert "--max-tokens" in res_drop.missing_tokens

    # Clean output passes all verifier checks
    res_clean = verify_rewrite(sample, sample, "web_github_pr")
    assert res_clean.passed_all is True

    # Sanitize model output removes <think> tags and code fences
    dirty = '<think>internal reasoning</think>\n```text\n"Clean sentence."\n```'
    assert sanitize_model_output(dirty) == "Clean sentence."


def test_surface_compliance_validator() -> None:
    """Verify surface rules including banned openers, link/emoji/hashtag bans, and ide_git_commit rules."""
    # Reddit forbids links, emojis, hashtags, em dashes, and banned openers
    v_reddit = validate_surface_compliance(
        "Great question! Check https://example.com #rust \U0001f680 \u2014 fast.",
        "web_reddit",
    )
    kinds = {v.kind for v in v_reddit}
    assert "opener" in kinds
    assert "link" in kinds
    assert "hashtag" in kinds
    assert "emoji" in kinds
    assert "em_dash" in kinds

    # ide_git_commit enforces <= 72 chars, no trailing period, and imperative mood
    v_commit_bad = validate_surface_compliance(
        "feat(core): added a very long commit subject line that exceeds seventy-two characters and ends with a period.",
        "ide_git_commit",
    )
    commit_kinds = {v.kind for v in v_commit_bad}
    assert "commit_subject_length" in commit_kinds
    assert "commit_subject_period" in commit_kinds
    assert "commit_mood" in commit_kinds

    v_commit_good = validate_surface_compliance(
        "feat(core): add unit-bound numeric verifier in `lexel-core` for #42",
        "ide_git_commit",
    )
    assert v_commit_good == []


def test_all_six_crucible_gates() -> None:
    """Test all 6 Data Crucible gates individually and via DataCrucible.audit_sample."""
    # Gate 1: ZeroSlopGate (ignores em dashes inside code spans, flags them in prose)
    g1 = ZeroSlopGate()
    assert g1.evaluate("Use `a -- b` in code, and plain commas in prose.").passed is True
    assert g1.evaluate("We seamlessly delve into the tapestry \u2014 fast.").passed is False

    # Gate 2: NumericAndTokenGroundingGate
    g2 = NumericAndTokenGroundingGate()
    src = "Cut latency from 40ms to 12ms in #88 using `--fast` and `lexel-core`."
    assert g2.evaluate(src, src).passed is True
    assert (
        g2.evaluate(
            "Cut latency from 40ms to 15ms in #88 using `--fast` and `lexel-core`.",
            src,
        ).passed
        is False
    )

    # Gate 3: SurfaceComplianceGate
    g3 = SurfaceComplianceGate()
    assert g3.evaluate("Short sharp X post with 12ms latency.", "web_x").passed is True
    assert g3.evaluate("x" * 300, "web_x").passed is False

    # Gate 4: ActiveVerbAndDirectnessGate
    g4 = ActiveVerbAndDirectnessGate(avr_threshold=0.85)
    assert (
        g4.evaluate(
            "Engineers deployed the new parser and reduced memory usage by 30%."
        ).passed
        is True
    )
    assert (
        g4.evaluate("Sure, here is your rewrite: The file was updated.").passed
        is False
    )
    assert (
        g4.evaluate("<think>hidden</think>Engineers fixed the bug.").passed
        is False
    )
    assert (
        g4.evaluate(
            "The cable was noticed, the server was restarted, and the ticket was closed."
        ).passed
        is False
    )

    # Gate 5: LexicalDensityAndBurstinessGate
    g5 = LexicalDensityAndBurstinessGate(
        mattr_threshold=0.65, burstiness_threshold=2.0
    )
    varied_prose = (
        "Small models need strict boundaries. "
        "When we offload deterministic grammar rules to a fast Rust engine and verify every numeric metric after inference, "
        "a compact local model rewrites technical prose accurately without sending private drafts across the network."
    )
    res5 = g5.evaluate(varied_prose)
    assert res5.passed is True
    assert res5.details["craft_score"] > 0.60

    # Gate 6: IntegrityAndLeakageGate
    g6 = IntegrityAndLeakageGate(
        near_dup_threshold=0.85, leakage_threshold=0.30
    )
    g6.register_heldout_corpus(
        [
            (
                "eval_leak_1",
                "Switching our parser from serde_json Value to borrowed str slices cut allocation count by 82 percent.",
            )
        ]
    )
    clean_line = "Transaction pooling with 64 connections reduced p99 query latency to 28ms."
    assert (
        g6.evaluate(
            clean_line,
            surface_id="web_reddit",
            example_id="ex1",
            register_in_corpus=True,
        ).passed
        is True
    )
    # Exact duplicate fails
    assert (
        g6.evaluate(
            clean_line,
            surface_id="web_reddit",
            example_id="ex2",
            register_in_corpus=True,
        ).passed
        is False
    )
    # Unclosed backtick fails
    assert (
        g6.evaluate(
            "Broken `inline code token without closing backtick.",
            surface_id="general",
            example_id="ex3",
        ).passed
        is False
    )
    # 8-gram held-out leakage fails
    leaked_line = "Switching our parser from serde_json Value to borrowed str slices cut allocation count by 82 percent yesterday."
    assert (
        g6.evaluate(
            leaked_line,
            surface_id="general",
            example_id="ex4",
        ).passed
        is False
    )


def test_surgical_counterfactual_mutation_and_token_mask() -> None:
    """Verify all 7 PerturbationTypes, character span accuracy, token mask alignment, and reverse-slop synthesis."""
    base = (
        "PostgreSQL connection pooling in `lexel-db` did not drop any queries, "
        "cutting p99 latency from 120ms to 18ms for #42 via `--pool-size` and https://lexel.dev/db."
    )

    for p_fn, expected_type in [
        (perturb_numerical, PerturbationType.NUMERICAL),
        (perturb_entity, PerturbationType.ENTITY_SWAP),
        (perturb_slop, PerturbationType.AI_SLOP),
        (perturb_negation, PerturbationType.NEGATION),
        (perturb_em_dash, PerturbationType.EM_DASH_INJECTION),
        (perturb_code_token_drop, PerturbationType.CODE_TOKEN_DROP),
    ]:
        mutated, spans = p_fn(base, seed=42)
        assert mutated != base
        assert len(spans) == 1
        sp = spans[0]
        assert sp.perturbation_type == expected_type
        assert mutated[sp.start_char : sp.end_char] == sp.perturbed

        mask = align_spans_to_token_mask(None, mutated, spans)
        assert len(mask) > 0
        assert sum(mask) >= 1
        assert any(m == 0 for m in mask)

    mut_surf, surf_spans = perturb_surface_violation(
        base, surface_id="web_reddit", seed=42
    )
    assert mut_surf != base
    assert surf_spans[0].perturbation_type == PerturbationType.SURFACE_VIOLATION

    # Test unified generator and reverse-slop synthesizer
    gen_text, gen_pt, gen_spans = generate_surgical_counterfactual(
        base, seed=7
    )
    assert gen_text != base
    assert len(gen_spans) == 1

    sloppy_source = inject_reverse_slop(
        base, surface_id="web_github_pr", task="deslop", seed=42
    )
    assert sloppy_source != base
    # Reverse slop must preserve 100% of unit-bound numbers and code/URL/CLI tokens
    g2 = NumericAndTokenGroundingGate()
    assert g2.evaluate(target=base, source=sloppy_source).passed is True


def test_completion_only_masking_and_sequence_packing() -> None:
    """Verify -100 completion-only prompt masking, FFD/BFD sequence packing, position_ids reset, and cu_seqlens."""
    items = [
        PackingItem(
            item_id="a",
            input_ids=[1, 2, 3, 4, 5, 6],
            labels=[-100, -100, 3, 4, 5, 6],
        ),
        PackingItem(
            item_id="b",
            input_ids=[10, 11, 12, 13],
            labels=[-100, -100, 12, 13],
        ),
        PackingItem(
            item_id="c",
            input_ids=[20, 21, 22, 23, 24],
            labels=[-100, -100, 22, 23, 24],
        ),
    ]
    ffd_bins = pack_sequences_ffd(items, max_seq_length=10)
    bfd_bins = pack_sequences_bfd(items, max_seq_length=10)
    assert len(ffd_bins) == 2
    assert len(bfd_bins) == 2

    raw_dataset = [
        {
            "example_id": "a",
            "input_ids": [1, 2, 3, 4, 5, 6],
            "labels": [-100, -100, 3, 4, 5, 6],
        },
        {
            "example_id": "b",
            "input_ids": [10, 11, 12, 13],
            "labels": [-100, -100, 12, 13],
        },
    ]
    packed_rows, summary = pack_tokenized_dataset(
        raw_dataset, max_seq_length=10, algorithm="ffd"
    )
    assert len(packed_rows) == 1
    assert summary.num_bins == 1
    assert summary.packing_efficiency == 1.0

    row = packed_rows[0]
    assert row["position_ids"] == [0, 1, 2, 3, 4, 5, 0, 1, 2, 3]
    assert row["cu_seqlens"] == [0, 6, 10]
    assert row["seq_idx"] == [0, 0, 0, 0, 0, 0, 1, 1, 1, 1]

    collator = PackedBatchCollator(pad_to_multiple_of=8, return_tensors="list")
    batch = collator(packed_rows)
    assert len(batch["input_ids"][0]) == 16
    assert batch["labels"][0][10:] == [-100] * 6


def test_masked_simpo_and_dpo_zero_unmasked_gradient() -> None:
    """Verify MaskedSimPOLoss and MaskedDPOLoss produce identically zero gradient on unmasked tokens when alpha=0."""
    # Shape: B=1, L=5, V=4
    chosen_logits = [
        [
            [2.0, 0.5, -1.0, 0.0],
            [0.1, 2.5, -0.5, 0.0],
            [-0.5, 0.2, 3.0, 0.1],
            [0.0, -1.0, 0.5, 2.2],
            [1.0, 1.0, 1.0, 1.0],
        ]
    ]
    rejected_logits = [
        [
            [1.5, 1.0, -0.5, 0.0],
            [0.5, 1.2, 0.8, -0.2],
            [1.8, -0.5, 0.1, 0.4],
            [-0.2, 2.0, 0.3, 0.1],
            [1.0, 1.0, 1.0, 1.0],
        ]
    ]
    # Prompt token at index 0-1 (-100), supervised completion tokens at indices 2, 3, 4
    chosen_labels = [[-100, -100, 1, 2, 3]]
    rejected_labels = [[-100, -100, 1, 0, 1]]
    # Only token at position 3 (shifted position 2) is mutated (mask == 1)
    rejected_token_mask = [[0, 0, 0, 1, 0]]

    lprobs = compute_token_logprobs(chosen_logits, chosen_labels)
    assert len(lprobs[0]) == 4
    assert lprobs[0][0] == 0.0

    simpo_pure = MaskedSimPOLoss(
        beta=2.0, gamma=1.0, unmasked_token_weight=0.0, sft_weight=0.05
    )
    out_simpo = simpo_pure(
        chosen_logits=chosen_logits,
        chosen_labels=chosen_labels,
        rejected_logits=rejected_logits,
        rejected_labels=rejected_labels,
        rejected_token_mask=rejected_token_mask,
    )
    metrics = out_simpo.to_metrics()
    assert metrics["loss"] > 0.0
    assert "nll_loss" in metrics

    # Shifted indices: index 0 is -100 (grad 0), index 1 is unmasked valid token (grad MUST be 0.0 when alpha=0),
    # index 2 is masked mutated token (grad > 0), index 3 is unmasked valid token (grad MUST be 0.0)
    grads = out_simpo.rejected_token_gradients[0]
    assert grads[0] == 0.0
    assert grads[1] == 0.0
    assert grads[2] > 0.0
    assert grads[3] == 0.0

    # Verify altering unmasked rejected token logits does NOT change rejected_reward when alpha=0
    rejected_logits_perturbed_unmasked = [
        [list(tok) for tok in rejected_logits[0]]
    ]
    rejected_logits_perturbed_unmasked[0][1] = [10.0, -10.0, 5.0, 0.0]
    out_simpo_2 = simpo_pure(
        chosen_logits=chosen_logits,
        chosen_labels=chosen_labels,
        rejected_logits=rejected_logits_perturbed_unmasked,
        rejected_labels=rejected_labels,
        rejected_token_mask=rejected_token_mask,
    )
    assert abs(
        out_simpo.to_metrics()["rejected_reward"]
        - out_simpo_2.to_metrics()["rejected_reward"]
    ) < 1e-9

    # Also test MaskedDPOLoss
    dpo_pure = MaskedDPOLoss(beta=0.1, unmasked_token_weight=0.0)
    out_dpo = dpo_pure(
        policy_chosen_logits=chosen_logits,
        policy_rejected_logits=rejected_logits,
        reference_chosen_logits=chosen_logits,
        reference_rejected_logits= chosen_logits,
        chosen_labels=chosen_labels,
        rejected_labels=rejected_labels,
        rejected_token_mask=rejected_token_mask,
    )
    dpo_grads = out_dpo.rejected_token_gradients[0]
    assert dpo_grads[1] == 0.0
    assert dpo_grads[2] > 0.0
    assert dpo_grads[3] == 0.0


def test_statistical_evaluation_and_writing_bench_critic() -> None:
    """Verify Clopper-Pearson CI, binomial sign test, and WritingBenchCritic swap/length debiasing."""
    lo, hi = clopper_pearson_interval(26, 26)
    assert 0.80 < lo <= 1.0
    assert hi == 1.0
    assert clopper_pearson_interval(0, 20)[0] == 0.0

    p_val = sign_test_p_value(18, 20)
    assert p_val < 0.001
    assert sign_test_p_value(10, 20) > 0.5

    critic = WritingBenchCritic(length_bias_beta=0.01)
    brief = {
        "source_material": "Cut p99 query latency from 420ms to 28ms across 64 PgBouncer connections.",
        "surface_id": "web_github_pr",
    }
    clean_a = "PgBouncer connection pooling with 64 connections cut p99 query latency from 420ms to 28ms."
    sloppy_b = (
        "Sure, here is your text! In today's rapidly evolving ecosystem \u2014 we seamlessly "
        "leveraged PgBouncer to unlock a pivotal paradigm shift reducing latency from 999ms to 5ms."
    )

    cmp_ab = critic.evaluate_pair(brief, clean_a, sloppy_b)
    assert cmp_ab.winner == "A"
    assert cmp_ab.is_position_consistent is True
    assert cmp_ab.scores_a.factual_grounding > cmp_ab.scores_b.factual_grounding
    assert (
        cmp_ab.scores_a.anti_slop_integrity
        > cmp_ab.scores_b.anti_slop_integrity
    )

    calibrator = JudgeCalibrator(critic)
    cal_report = calibrator.calibrate(
        [
            {
                "brief": brief,
                "chosen": clean_a,
                "rejected": sloppy_b,
                "perturbation_type": "corporate_slop",
            }
        ]
    )
    assert cal_report.accuracy_raw == 1.0


def test_generated_datasets_and_kaggle_notebooks_valid() -> None:
    """Verify generated ml/datasets/*.jsonl, manifest.json, unsloth_preflight.py, and ml/kaggle/*.ipynb."""
    datasets_dir = REPO_ROOT / "ml" / "datasets"
    sft_train = datasets_dir / "lexel_sft_train.jsonl"
    sft_val = datasets_dir / "lexel_sft_val.jsonl"
    dpo_train = datasets_dir / "lexel_dpo_train.jsonl"
    heldout_eval = datasets_dir / "lexel_heldout_eval.jsonl"
    manifest_file = datasets_dir / "manifest.json"

    for p in (sft_train, sft_val, dpo_train, heldout_eval, manifest_file):
        assert p.is_file(), f"Missing dataset artifact: {p}"

    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    assert manifest["crucible_gate_stats"]["final_split_crucible_pass_rate"] == 1.0
    assert set(manifest["surface_distribution"]["train"].keys()) == set(
        ALL_SURFACE_IDS
    )
    assert set(manifest["surface_distribution"]["heldout"].keys()) == set(
        ALL_SURFACE_IDS
    )

    # Check heldout evaluation pass rates on reference targets
    heldout_rows = [
        json.loads(line)
        for line in heldout_eval.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    eval_summary = evaluate_heldout_generations(heldout_rows)
    assert eval_summary["gates_passed"] is True
    assert eval_summary["zero_slop_rate"] == 1.0
    assert eval_summary["number_preservation_rate"] == 1.0
    assert eval_summary["token_preservation_rate"] == 1.0
    assert eval_summary["surface_compliance_rate"] == 1.0

    # Check DPO rows have required fields
    dpo_rows = [
        json.loads(line)
        for line in dpo_train.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert len(dpo_rows) >= 300
    for r in dpo_rows[:20]:
        for key in (
            "prompt",
            "chosen",
            "rejected",
            "perturbation_type",
            "perturbed_spans",
            "rejected_token_mask",
        ):
            assert key in r
        assert sum(r["rejected_token_mask"]) >= 1

    # Run unsloth_preflight.py and verify exit code 0 and ok == True
    preflight_script = (
        REPO_ROOT / ".agents" / "skills" / "unsloth" / "scripts" / "unsloth_preflight.py"
    )
    proc = subprocess.run(
        [
            sys.executable,
            str(preflight_script),
            "dataset",
            str(sft_train),
            "--eval-file",
            str(sft_val),
            "--json",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    preflight_json = json.loads(proc.stdout)
    assert preflight_json["ok"] is True
    assert preflight_json["overlap_unique_rows"] == 0
    assert preflight_json["train"]["issue_count"] == 0
    assert preflight_json["eval"]["issue_count"] == 0

    # Verify Jupyter notebooks in ml/kaggle/*.ipynb are valid nbformat v4 JSON and every code cell compiles as pure Python
    kaggle_dir = REPO_ROOT / "ml" / "kaggle"
    written_nbs = write_all_kaggle_notebooks(kaggle_dir)
    assert len(written_nbs) == 3

    for nb_name in (
        "lexel-sft-kaggle.ipynb",
        "lexel-dpo-gguf-kaggle.ipynb",
        "lexel-end-to-end-kaggle.ipynb",
    ):
        nb_path = kaggle_dir / nb_name
        assert nb_path.is_file()
        nb_data = json.loads(nb_path.read_text(encoding="utf-8"))
        assert nb_data["nbformat"] == 4
        assert len(nb_data["cells"]) >= 6
        for cell_idx, cell in enumerate(nb_data["cells"]):
            if cell["cell_type"] == "code":
                source_code = "".join(cell["source"])
                assert "!pip" not in source_code, (
                    f"{nb_name} cell {cell_idx} contains shell magic !pip"
                )
                ast.parse(source_code, filename=f"{nb_name}#cell_{cell_idx}")

    # Verify Kaggle Dataset metadata and rule copies exist in ml/datasets/
    assert (datasets_dir / "dataset-metadata.json").is_file()
    assert (datasets_dir / "slop_terms.json").is_file()
    assert (datasets_dir / "surfaces.json").is_file()

    # Verify PreferenceBatchCollator aligns token masks and pads cleanly
    pref_collator = PreferenceBatchCollator(
        tokenizer=None, max_seq_length=256, pad_to_multiple_of=8, return_tensors="list"
    )
    from ml.crucible.counterfactual import _WhitespaceFallbackTokenizer

    pref_collator.tokenizer = _WhitespaceFallbackTokenizer()
    collated_dpo = pref_collator(dpo_rows[:2])
    assert len(collated_dpo["chosen_input_ids"]) == 2
    assert len(collated_dpo["rejected_input_ids"]) == 2
    assert len(collated_dpo["chosen_input_ids"][0]) % 8 == 0
    assert len(collated_dpo["rejected_input_ids"][0]) % 8 == 0
    assert sum(collated_dpo["rejected_token_mask"][0]) >= 1
    assert sum(collated_dpo["rejected_token_mask"][1]) >= 1
