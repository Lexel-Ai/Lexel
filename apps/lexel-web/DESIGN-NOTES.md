# Lexel Web Design Notes (`apps/lexel-web`)

antislop active: during (global preference).

## Design Read

Reading this as: public site, technical documentation, and live in-browser Tier 0 playground for developers and everyday writers, in a monochrome editorial writing-instrument language from `DESIGN.md`, dial ENERGY 1 / RHYTHM 2 / MOTION 1.

## Visual Decisions (R-31)

- **Color palette (`DESIGN.md`):** Carbon black (`#09090B`) and paper white (`#FFFFFF`) monochrome canvas paired with one deliberate Proofreader Cobalt accent (`#60A5FA` dark / `#2563EB` light) for focus rings, verified gates, and active states; amber (`#F59E0B` / `#B45309`) and red (`#F87171` / `#DC2626`) appear only on real lint, slop, and secret findings. All text pairings verified >= 4.5:1 WCAG AA; interactive control borders use `#71717A` (>= 3:1 non-text contrast in both modes).
- **Theme handling:** Respects OS preference by default via `<meta name="color-scheme" content="light dark">` and `:root` `color-scheme` mapping, with an inline pre-paint FOUC-prevention script and a two-state header toggle that persists explicit overrides in `localStorage` and deletes the override when returning to system preference.
- **Typography:** Local `'IBM Plex Sans'` editorial sans stack for UI and documentation prose (zero third-party font fetches, zero telemetry, zero CLS) and `'JetBrains Mono'` strictly for CLI commands, `.lexel.toml`, LSP snippets, byte sizes, SHA-256 digests, and live counters.
- **Identity motif:** Proofreader editorial margin markers (`01`, `02`, `03`), 1px structural hairline dividers (`--lx-border`), and tight radii (`4px` tags, `6px` controls, `8px` panels) inspired by a physical markup sheet rather than SaaS card templates.
- **Layout and section rhythm (RHYTHM 2):** Content-driven landing sequence that varies composition across sections: split hero paired with a real live Tier 0 diagnostic preview, horizontal two-tier execution pipeline strip, interactive 13-surface specification matrix, tabbed platform install switcher, two-column factual privacy/model specification table, and a compact editorial footer linking only to real pages and repository URLs.
- **Icons and decoration:** Reuses `NibIcon`, `SunIcon`, `MoonIcon`, `CheckIcon`, and `CloseIcon` from `packages/lexel-ui` for functional UI affordances only; zero decorative emojis, zero sparkle/magic/robot glyphs, zero eyebrow pills above H1, zero fake terminal windows, zero background grids, and zero gradients.
- **Motion (MOTION 1):** Crisp hover, active, and focus-visible transitions only, disabled automatically under `prefers-reduced-motion: reduce`.
- **Accessibility and mobile:** Semantic landmarks (`header`, `nav`, `main`, `footer`), skip-to-content link, `cursor: pointer` on enabled interactive controls, `>= 44px` touch targets on mobile navigation and primary controls, single-row horizontally scrollable tablists with keyboard arrow navigation, responsive `@container` tables that stack cleanly on narrow screens, and explicit empty, loading, and error states on the Playground.
