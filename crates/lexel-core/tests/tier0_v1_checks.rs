use std::time::Instant;

use lexel_core::{
    ConsistencyKind, SlopMeterContributorKind, SlopMeterLabel, SlopMeterOptions, Tier0CheckOptions,
    Tier0Engine, WritingGuardKind, detect_pasted_ai, scan_bluf_and_walls, scan_consistency_issues,
    scan_crutch_words, scan_regret_shield, score_slop_meter, split_paragraphs,
};

const TYPICAL_PARAGRAPH: &str = "In today's rapidly evolving ecosystem, we should delve into how teams leverage seamless workflows — without breaking production. Please review the colour settings and color tokens for v1.0 and 1.1 on Github. Obviously, I just wanted to share this e-mail and email update, see attached.";

#[test]
fn slop_meter_scores_cliches_em_dashes_openers_and_flat_rhythm() {
    let ai_text = concat!(
        "In today's rapidly evolving landscape, teams delve into seamless solutions — unlocking synergy. ",
        "Furthermore, modern engineering groups carefully build scalable pipelines for every release today. ",
        "Moreover, product leaders consistently drive durable alignment across every quarterly roadmap milestone. ",
        "Ultimately, focused organizations steadily produce measurable outcomes across every global customer segment."
    );
    let report = score_slop_meter(ai_text, &SlopMeterOptions::default());
    assert!(
        report.score >= 55,
        "expected high slop score, got {report:?}"
    );
    assert_eq!(report.human_score, 100 - report.score);
    assert!(matches!(
        report.label,
        SlopMeterLabel::LikelyAi | SlopMeterLabel::HeavySlop
    ));
    assert!(report.cliche_count >= 4);
    assert_eq!(report.em_dash_count, 1);
    assert!(report.filler_opener_count >= 1);
    assert!(report.rhythm_flatness > 0.45);
    assert!(
        report
            .contributors
            .iter()
            .any(|c| c.kind == SlopMeterContributorKind::Cliche)
    );
    assert!(
        report
            .contributors
            .iter()
            .any(|c| c.kind == SlopMeterContributorKind::EmDash)
    );
    assert!(
        report
            .contributors
            .iter()
            .any(|c| c.kind == SlopMeterContributorKind::FillerOpener)
    );
    assert!(
        report
            .contributors
            .iter()
            .any(|c| c.kind == SlopMeterContributorKind::FlatRhythm)
    );

    // Clean human prose with varied sentence lengths should score low.
    let human_text = "We cut p95 latency from 42ms to 18ms. How? We removed two redundant regex compilations in the hot path, cached the Aho-Corasick automaton once at startup, and verified zero regressions across all 48 tests. Ship it.";
    let human = score_slop_meter(human_text, &SlopMeterOptions::default());
    assert!(
        human.score <= 15,
        "expected clean human text to score <= 15, got {human:?}"
    );
    assert_eq!(human.label, SlopMeterLabel::Human);

    // Code blocks and quotes must be ignored.
    let code_only = "```rust\n// delve into seamless synergy —\n```\n> delve into tapestry";
    let code_report = score_slop_meter(code_only, &SlopMeterOptions::default());
    assert_eq!(code_report.score, 0);
}

#[test]
fn pasted_ai_detector_enforces_length_and_slop_density() {
    let short_slop = "Let's delve into this seamless tapestry — fast.";
    let short_eval = detect_pasted_ai(short_slop, &SlopMeterOptions::default());
    assert!(
        !short_eval.should_offer_humanize,
        "short paste below 120 chars should not trigger pill"
    );

    let long_human = "We migrated the worker queue from polling to event notifications yesterday morning. CPU usage dropped from 14% to 2% across all three staging nodes. Let me know if you spot any edge cases when testing with empty batches or slow disk writes.";
    let human_eval = detect_pasted_ai(long_human, &SlopMeterOptions::default());
    assert!(
        !human_eval.should_offer_humanize,
        "long clean human paste should not trigger pill: {human_eval:?}"
    );

    let long_ai = "In today's rapidly evolving software world, teams must delve into cutting-edge tooling — leveraging seamless workflows to unlock paradigm shifts and foster holistic synergy across the entire engineering realm.";
    let ai_eval = detect_pasted_ai(long_ai, &SlopMeterOptions::default());
    assert!(
        ai_eval.should_offer_humanize,
        "long AI-heavy paste should offer humanize pill: {ai_eval:?}"
    );
    assert!(ai_eval.reason.is_some());
    assert!(ai_eval.signal_count >= 4);
}

#[test]
fn consistency_checker_catches_dialect_hyphenation_casing_and_versions() {
    let doc = concat!(
        "We set the primary color and secondary color tokens, then update the border colour.\n",
        "Send an email to support and confirm the e-mail address in settings.\n",
        "Push the branch to Github and open a Typescript pull request on https://github.com/org/repo.\n",
        "Upgrade clients from v1.0 and v1.1 to 1.2 without changing 127.0.0.1 or 2.5ms metrics."
    );
    let issues = scan_consistency_issues(doc, None);

    let spelling = issues
        .iter()
        .find(|i| i.kind == ConsistencyKind::SpellingDialect)
        .expect("should flag mixed US/UK spelling");
    assert_eq!(spelling.found, "colour");
    assert_eq!(spelling.preferred, "color");

    let hyphen = issues
        .iter()
        .find(|i| i.kind == ConsistencyKind::Hyphenation)
        .expect("should flag mixed email/e-mail hyphenation");
    assert_eq!(hyphen.found, "e-mail");
    assert_eq!(hyphen.preferred, "email");

    let casing: Vec<(&str, &str)> = issues
        .iter()
        .filter(|i| i.kind == ConsistencyKind::ProductCasing)
        .map(|i| (i.found.as_str(), i.preferred.as_str()))
        .collect();
    assert!(casing.contains(&("Github", "GitHub")), "casing: {casing:?}");
    assert!(
        casing.contains(&("Typescript", "TypeScript")),
        "casing: {casing:?}"
    );
    // URL https://github.com/... must NOT be flagged.
    assert_eq!(
        casing
            .iter()
            .filter(|(f, _)| f.eq_ignore_ascii_case("github"))
            .count(),
        1
    );

    let version = issues
        .iter()
        .find(|i| i.kind == ConsistencyKind::VersionFormat)
        .expect("should flag mixed v1.0 vs 1.2 version format");
    assert_eq!(version.found, "1.2");
    assert_eq!(version.preferred, "v1.2");
    assert!(
        !issues
            .iter()
            .any(|i| i.found.contains("127.0") || i.found == "2.5"),
        "IP addresses and metric units must not trigger version format issues: {issues:?}"
    );
}

#[test]
fn bluf_and_wall_of_text_detector_works_on_email_slack_and_pr() {
    let wall = concat!(
        "Line one of background context about the deployment pipeline and rollout timing.\n",
        "Line two adds historical detail about last quarter's migration and DNS changes.\n",
        "Line three explains the staging environment differences across regions.\n",
        "Line four covers retry backoff policies and worker pool saturation.\n",
        "Line five lists logs from the load balancer during peak traffic.\n",
        "Line six summarizes notes from yesterday's standup.\n",
        "Line seven finally asks: can you approve PR #42 before 5pm?"
    );

    let email_hits = scan_bluf_and_walls(wall, "web_email");
    assert!(
        email_hits
            .iter()
            .any(|h| h.kind == WritingGuardKind::WallOfText),
        "expected wall of text on email: {email_hits:?}"
    );
    assert!(
        email_hits
            .iter()
            .any(|h| h.kind == WritingGuardKind::BuriedAsk),
        "expected buried ask on email: {email_hits:?}"
    );

    assert!(!scan_bluf_and_walls(wall, "web_discord_slack").is_empty());
    assert!(!scan_bluf_and_walls(wall, "web_github_pr").is_empty());
    assert!(
        scan_bluf_and_walls(wall, "web_substack").is_empty(),
        "non-BLUF editorial surface should not trigger BLUF/wall alerts"
    );

    // Lead-first email with short paragraphs should pass cleanly.
    let bluf_ok = "Can you approve PR #42 before 5pm?\n\nContext: staging passed all checks and p95 latency fell from 42ms to 18ms.\n\nNo schema changes are included.";
    assert!(scan_bluf_and_walls(bluf_ok, "web_email").is_empty());
}

#[test]
fn regret_shield_and_personal_crutch_words_work() {
    let harsh = "Obviously, as I already said, why didn't you run the tests? Please see attached for the logs.";
    let regret_no_attach = scan_regret_shield(harsh, false);
    assert_eq!(
        regret_no_attach
            .iter()
            .filter(|h| h.kind == WritingGuardKind::AbrasiveTone)
            .count(),
        3,
        "got: {regret_no_attach:?}"
    );
    assert!(
        regret_no_attach
            .iter()
            .any(|h| h.kind == WritingGuardKind::MissingAttachment)
    );

    let regret_with_attach = scan_regret_shield(harsh, true);
    assert!(
        !regret_with_attach
            .iter()
            .any(|h| h.kind == WritingGuardKind::MissingAttachment),
        "attachment signal should suppress missing-attachment warning"
    );

    let crutch_list = vec![
        "just".to_owned(),
        "actually".to_owned(),
        "basically => in short".to_owned(),
    ];
    let draft =
        "I just wanted to actually check if `just` in code stays safe, and basically wrap up.";
    let crutch_hits = scan_crutch_words(draft, &crutch_list);
    assert_eq!(crutch_hits.len(), 3, "got: {crutch_hits:?}");
    assert!(
        crutch_hits
            .iter()
            .all(|h| h.kind == WritingGuardKind::CrutchWord)
    );
    let basically_hit = crutch_hits
        .iter()
        .find(|h| h.matched_text.eq_ignore_ascii_case("basically"))
        .unwrap();
    assert_eq!(basically_hit.suggestion.as_deref(), Some("in short"));
}

#[test]
fn paragraph_hash_cache_only_relints_edited_paragraph_with_exact_offsets() {
    let mut paragraphs: Vec<String> = (0..12)
        .map(|i| {
            format!(
                "Paragraph {i} explains how local caching keeps editing responsive for long technical notes."
            )
        })
        .collect();
    // Put a clear Harper grammar typo in paragraph 3 and paragraph 10.
    paragraphs[3] = "Paragraph 3 has an typo in the third section.".to_owned();
    paragraphs[10] = "Paragraph 10 also has an typo near the end.".to_owned();

    let doc_v1 = paragraphs.join("\n\n");
    assert_eq!(split_paragraphs(&doc_v1).len(), 12);

    let mut engine = Tier0Engine::new();
    let opts = Tier0CheckOptions {
        surface_id: "web_github_pr".to_owned(),
        language: "markdown".to_owned(),
        crutch_words: vec!["just".to_owned()],
        ..Tier0CheckOptions::default()
    };

    let r1 = engine.check(&doc_v1, &opts).expect("first check");
    assert_eq!(r1.cache_stats.paragraphs_total, 12);
    assert_eq!(r1.cache_stats.cache_hits, 0);
    assert_eq!(r1.cache_stats.cache_misses, 12);
    assert!(r1.harper.len() >= 2);

    // Edit only paragraph 6; paragraphs 0..5 and 7..11 must hit the cache.
    paragraphs[6] = "Paragraph 6 was updated with an typo right here.".to_owned();
    let doc_v2 = paragraphs.join("\n\n");

    let r2 = engine.check(&doc_v2, &opts).expect("second check");
    assert_eq!(r2.cache_stats.paragraphs_total, 12);
    assert_eq!(r2.cache_stats.cache_hits, 11);
    assert_eq!(r2.cache_stats.cache_misses, 1);

    // Offsets must match a fresh uncached run on doc_v2 byte-for-byte/char-for-char.
    let mut fresh = Tier0Engine::new();
    let r_fresh = fresh.check(&doc_v2, &opts).expect("fresh check");
    assert_eq!(r2.harper, r_fresh.harper);

    // Fenced code blocks with blank lines stay in one paragraph block.
    let fenced = "Intro text.\n\n```rust\nfn a() {}\n\nfn b() {}\n```\n\nOutro text.";
    assert_eq!(split_paragraphs(fenced).len(), 3);
}

#[test]
fn latency_budget_all_new_checks_run_under_2ms_on_typical_paragraph() {
    let meter_opts = SlopMeterOptions::default();
    let crutch = vec![
        "just".to_owned(),
        "actually".to_owned(),
        "basically".to_owned(),
        "honestly".to_owned(),
    ];

    // Warm up OnceLock statics and Harper curated dictionary.
    let _ = score_slop_meter(TYPICAL_PARAGRAPH, &meter_opts);
    let _ = detect_pasted_ai(TYPICAL_PARAGRAPH, &meter_opts);
    let _ = scan_consistency_issues(TYPICAL_PARAGRAPH, Some(0));
    let _ = scan_bluf_and_walls(TYPICAL_PARAGRAPH, "web_email");
    let _ = scan_regret_shield(TYPICAL_PARAGRAPH, false);
    let _ = scan_crutch_words(TYPICAL_PARAGRAPH, &crutch);

    let iterations = 50usize;

    let t0 = Instant::now();
    for _ in 0..iterations {
        let _ = score_slop_meter(TYPICAL_PARAGRAPH, &meter_opts);
    }
    let slop_meter_avg_ms = t0.elapsed().as_secs_f64() * 1000.0 / iterations as f64;

    let t1 = Instant::now();
    for _ in 0..iterations {
        let _ = detect_pasted_ai(TYPICAL_PARAGRAPH, &meter_opts);
    }
    let pasted_ai_avg_ms = t1.elapsed().as_secs_f64() * 1000.0 / iterations as f64;

    let t2 = Instant::now();
    for _ in 0..iterations {
        let _ = scan_consistency_issues(TYPICAL_PARAGRAPH, Some(0));
    }
    let consistency_avg_ms = t2.elapsed().as_secs_f64() * 1000.0 / iterations as f64;

    let t3 = Instant::now();
    for _ in 0..iterations {
        let _ = scan_bluf_and_walls(TYPICAL_PARAGRAPH, "web_email");
        let _ = scan_regret_shield(TYPICAL_PARAGRAPH, false);
        let _ = scan_crutch_words(TYPICAL_PARAGRAPH, &crutch);
    }
    let guards_avg_ms = t3.elapsed().as_secs_f64() * 1000.0 / iterations as f64;

    // Also measure incremental paragraph-cached Harper linting on a 10-paragraph doc (cold vs 1-paragraph edit).
    let mut engine = Tier0Engine::new();
    let opts = Tier0CheckOptions {
        surface_id: "web_email".to_owned(),
        crutch_words: crutch.clone(),
        ..Tier0CheckOptions::default()
    };
    let mut paras: Vec<String> = (0..10)
        .map(|i| format!("Paragraph {i}: {TYPICAL_PARAGRAPH}"))
        .collect();
    let full_doc = paras.join("\n\n");
    // Prime Harper dictionary once.
    let _ = engine
        .check_harper("Warmup sentence.", &opts)
        .expect("warmup");
    engine.clear_cache();

    let t_cold = Instant::now();
    let (_cold_diags, cold_stats) = engine.check_harper(&full_doc, &opts).expect("cold check");
    let cold_10p_ms = t_cold.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(cold_stats.cache_hits, 0);
    assert_eq!(cold_stats.cache_misses, 10);

    paras[5] = format!("Paragraph 5 edited: {TYPICAL_PARAGRAPH}");
    let edited_doc = paras.join("\n\n");
    let t_inc = Instant::now();
    let (_inc_diags, inc_stats) = engine
        .check_harper(&edited_doc, &opts)
        .expect("incremental check");
    let inc_10p_ms = t_inc.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(inc_stats.cache_hits, 9);
    assert_eq!(inc_stats.cache_misses, 1);

    eprintln!(
        "Tier 0 measured avg latency (ms): slop_meter={slop_meter_avg_ms:.3}, pasted_ai={pasted_ai_avg_ms:.3}, consistency={consistency_avg_ms:.3}, guards={guards_avg_ms:.3}, harper_10p_cold={cold_10p_ms:.3}, harper_10p_incremental={inc_10p_ms:.3}"
    );

    // Guardrail: release mode must be well under 2 ms; even unoptimized debug stays fast.
    #[cfg(not(debug_assertions))]
    {
        assert!(
            slop_meter_avg_ms < 2.0,
            "slop_meter too slow: {slop_meter_avg_ms:.3}ms"
        );
        assert!(
            pasted_ai_avg_ms < 2.0,
            "pasted_ai too slow: {pasted_ai_avg_ms:.3}ms"
        );
        assert!(
            consistency_avg_ms < 2.0,
            "consistency too slow: {consistency_avg_ms:.3}ms"
        );
        assert!(guards_avg_ms < 2.0, "guards too slow: {guards_avg_ms:.3}ms");
    }
    #[cfg(debug_assertions)]
    {
        assert!(
            slop_meter_avg_ms < 10.0,
            "slop_meter debug too slow: {slop_meter_avg_ms:.3}ms"
        );
        assert!(
            consistency_avg_ms < 10.0,
            "consistency debug too slow: {consistency_avg_ms:.3}ms"
        );
        assert!(
            guards_avg_ms < 10.0,
            "guards debug too slow: {guards_avg_ms:.3}ms"
        );
    }
}
