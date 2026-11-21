# Lexel Desktop Design Notes (R-31 Decision Ledger)

Direction source: `/home/lawand/Lexel/DESIGN.md` (treated as design data).
Active antislop mode: `during` (global preference).
Dials: `ENERGY 1` (calm writing instrument), `RHYTHM 2` (navigation rail, primary writing canvas, right editorial inspector), `MOTION 1` (crisp press/hover states and functional toast/panel entrances with `prefers-reduced-motion` fallback).

## Visual & Craft Decisions (One-Line Reasons)

1. **Palette (Carbon Black `#09090B` / Paper White `#FFFFFF` + Proofreader Cobalt `#60A5FA` / `#2563EB`)**: Follows `DESIGN.md` monochrome editorial instrument identity so text diffs and warnings stay legible without decorative noise; every foreground/background pair verified >= 4.5:1 WCAG AA via `contrast-check.py`.
2. **Semantic Diff & Status Colors (`--lx-ok` `#4ADE80`/`#15803D`, `--lx-warn` `#F59E0B`/`#B45309`, `--lx-danger` `#F87171`/`#DC2626`)**: Reserved strictly for verified proofreader gates, hunk additions/deletions, warnings, and secret blocks, always paired with text labels or icons so no state relies on color alone.
3. **Typography (`IBM Plex Sans` for UI/prose + `JetBrains Mono` with `tabular-nums` for counters, latencies, and rule IDs)**: Keeps prose warm and scannable while preventing numeric jitter on live word counters, countdown timers, and latency readouts.
4. **Layout Composition (224px left rail + Studio 2-column canvas/inspector split)**: Separates the primary editing task (draft, tone pills, hunk diff) from secondary verification (Slop Meter, Tier 0 Guards, Readability) to match `DESIGN.md` RHYTHM 2 instead of a generic stat-card dashboard.
5. **Five Purpose-Built Views (`Studio`, `Voice & Insights`, `Surfaces & Snippets`, `Rules & Privacy`, `System & Doctor`)**: Gives each screen one clear job so writing, voice training/insights, prompt/snippet editing, privacy/rules, and system diagnostics never compete for focus.
6. **Custom Geometric 1.5px SVG Icons (`packages/lexel-ui/src/components/Icons.tsx`)**: Replaces generic Lucide rounded defaults with one cohesive, minimal single-stroke instrument icon set; zero decorative sparkles, stars, or emojis.
7. **Border Radii (`4px` badges, `6px` inputs/buttons, `8px` panels)**: Establishes consistent containment hierarchy across inline tokens, interactive controls, and outer surfaces without pill-shaping everything.
8. **Elevation & Shadows (flat hairline `1px` borders everywhere; `--lx-shadow-float` only on `UndoToast`)**: Keeps the workspace grounded on one plane and reserves drop shadow exclusively for the floating 10-second undo toast (R-12).
9. **Motion (`120ms` press `scale(0.98)` + `200ms` custom `cubic-bezier(0.23, 1, 0.32, 1)` panel entry; zero idle loops)**: Provides tactile confirmation on button clicks and smooth entry on diff cards/toasts while stripping transform motion under `prefers-reduced-motion: reduce`.
10. **Honest States & Real Metrics (`PrivacyProofBadge`, `InsightsVoicePane`, `DoctorHealthCard`)**: Displays zero invented numbers; unmeasured AI tok/s states "not measured" with a live benchmark button, and zero-check insight views show an explicit empty state with an action to open Studio.
11. **Full Keyboard & Touch Accessibility (`:focus-visible` 2px ring, native `<button>`/`<select>`, `44px` mobile nav targets, `Escape` on toast, arrow-key `TwoTakesPicker`)**: Ensures every workflow works identically via keyboard, pointer, and narrow viewports in both light and dark themes.
