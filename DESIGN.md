# Lexel Design System (`DESIGN.md`)

**Identity:** Monochrome editorial writing instrument (carbon black & pure paper white, one Proofreader Cobalt accent, zero SaaS clutter).

## 1. Visual Dials
- **ENERGY:** 1 (Calm, razor-sharp tool surface)
- **RHYTHM:** 2 (Clear structural separation: navigation rail, primary canvas, right inspector)
- **MOTION:** 1 (Crisp hover/focus states only; respects `prefers-reduced-motion`)

## 2. Color Tokens (Carbon Black & Paper White + Proofreader Cobalt)
Both themes are first-class and verified for >= 4.5:1 WCAG AA contrast:

| Semantic Token | Dark (`#09090B` Carbon) | Light (`#FFFFFF` Paper) | Purpose |
| :--- | :--- | :--- | :--- |
| `--lx-bg` | `#09090B` | `#FFFFFF` | Primary canvas & editor surface |
| `--lx-surface` | `#111113` | `#F7F7F8` | Secondary structural rails & toolbars |
| `--lx-card` | `#141416` | `#FFFFFF` | Popovers, diff panels, option groups |
| `--lx-muted` | `#1F1F23` | `#F1F1F2` | Secondary controls, code spans, inactive tabs |
| `--lx-fg` | `#FAFAFA` | `#0A0A0A` | Primary readable text |
| `--lx-fg-muted` | `#A1A1AA` | `#52525B` | Metadata, helper copy, labels |
| `--lx-border` | `#27272A` | `#E4E4E7` | Hairline 1px structural dividers |
| `--lx-accent` | `#FAFAFA` | `#0A0A0A` | Primary B&W action buttons & active nav |
| `--lx-on-accent` | `#09090B` | `#FFFFFF` | High-contrast text on primary B&W CTA |
| `--lx-signal` | `#60A5FA` | `#2563EB` | Deliberate Proofreader Cobalt accent (verified gates, active focus) |
| `--lx-warn` | `#F59E0B` | `#B45309` | Surface bound & anti-slop warnings |
| `--lx-danger` | `#F87171` | `#DC2626` | Spelling errors & destructive purge |

## 3. Typography & Radius
- **Body / UI:** `'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, sans-serif` (100% local stack).
- **Mono / Rule IDs / Counters:** `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`.
- **Radii:** `6px` inputs/buttons, `8px` panels/dialogs, `4px` inline badges.

## 4. Purpose-Built UI Rules
- Every screen has one clear primary job; writing, rule browsing, and system configuration are separated cleanly.
- Zero decorative emojis, zero generic sparkle/magic icons, zero purple-blue gradients.
- Honest empty, loading, and error states with next actions.
- Full keyboard accessibility (`Tab`, `ArrowUp`/`ArrowDown`, `Enter`, `Escape`) with visible focus rings.
