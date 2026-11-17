# Lexel Design Direction (`DESIGN.md`)

**Identity:** Developer-grade local writing instrument (ink-on-slate, quiet precision, zero SaaS clutter).

## 1. Visual Dials
- **ENERGY:** 1 (Calm, utilitarian tool surface)
- **RHYTHM:** 1 (Consistent, dense panels with clear hairline borders)
- **MOTION:** 1 (Crisp hover/focus states only; respects `prefers-reduced-motion`)

## 2. Color Tokens (Dark Default + Full Light Mode)
Both themes are first-class and verified for >= 4.5:1 text contrast:

| Semantic Token | Dark (`#0F172A` Slate Ink) | Light (`#F8FAFC` Paper) | Purpose |
| :--- | :--- | :--- | :--- |
| `--lx-bg` | `#0F172A` | `#F8FAFC` | Primary surface canvas |
| `--lx-card` | `#1B2336` | `#FFFFFF` | Cards, popovers, diff boxes |
| `--lx-muted` | `#272F42` | `#E2E8F0` | Secondary controls, input wells |
| `--lx-fg` | `#F8FAFC` | `#0F172A` | Primary readable text |
| `--lx-fg-muted` | `#94A3B8` | `#475569` | Metadata, helper copy, labels |
| `--lx-border` | `#334155` | `#CBD5E1` | Hairline 1px panel dividers |
| `--lx-accent` | `#22C55E` | `#15803D` | Verified pass badge & primary AI action |
| `--lx-on-accent` | `#052E16` | `#FFFFFF` | High-contrast text on accent CTA |
| `--lx-warn` | `#F59E0B` | `#B45309` | Surface bound / tone warnings |
| `--lx-danger` | `#EF4444` | `#B91C1C` | Spelling errors & destructive purge |

## 3. Typography & Radius
- **Body / UI:** `'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, sans-serif` (100% local stack, zero external font requests for privacy and MV3 CSP).
- **Mono / Surface Paths / Counters:** `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`.
- **Radii:** `6px` inputs/buttons, `8px` cards/panels, `4px` inline badges. No uniform pill-everything styling.

## 4. Purpose-Built UI Rules
- Zero decorative emojis, zero generic sparkle/magic icons, zero blue-purple gradients.
- Every panel displays honest empty, loading, and error states.
- Full keyboard accessibility (`Tab`, `Enter`, `Escape` to close inline overlays) with visible focus rings.
