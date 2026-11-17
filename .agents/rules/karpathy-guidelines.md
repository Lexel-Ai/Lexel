---
description: Behavioral guidelines to reduce common LLM coding mistakes. Use when writing, reviewing, or refactoring code to avoid overcomplication, make surgical changes, surface assumptions, and define verifiable success criteria.
alwaysApply: true
---

# Karpathy Behavioral Guidelines

## 1. Think Before Coding
- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them instead of guessing silently.
- If a simpler approach exists, propose it.

## 2. Simplicity First
- Minimum code that solves the problem. Nothing speculative.
- No abstractions for single-use code.
- No extra configurability that was not requested.
- If 200 lines can be written cleanly in 50, simplify it.

## 3. Surgical Changes
- Touch only what is needed for the task.
- Do not refactor unrelated working code or comments.
- Clean up imports/variables made unused by your own edit; report unrelated dead code rather than deleting it silently.

## 4. Goal-Driven Execution
- Turn requests into verifiable checks (tests first or tests alongside code, then run them).
- Loop until all checks pass before reporting completion.
