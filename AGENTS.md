# Repository instructions

## UI work

- Read `DESIGN.md` completely before creating or changing any UI, starting with the application-override block at the top.
- `assets/css/design-system.css` is the authoritative token source; `DESIGN.md` governs everything the override block does not contradict.
- Reuse the local tokens and primitives in `assets/css/design-system.css`; do not introduce ad-hoc colors, type scales, spacing, radii, shadows, or remote font/CDN dependencies.
- Inter (bundled in `assets/fonts/inter/`) is the primary face, ahead of the system fallbacks, so the app renders identically on every platform.
- The sole interactive accent is the Meleta gold from the logo: `--c-accent` (`#d9a43a`) for fills and marks, `--c-accent-ink` (`#8a6212`) when the accent is read as text. Action Blue is retired.
- The application canvas is white throughout. Do not reintroduce parchment or near-black section tiles; separate sections with spacing and type, not rules, borders, or boxed cards.
- Three measures, and they are not interchangeable: `--content-text` (720px) caps running text, `--content-app` (1040px) is the page shell, `--content-wide` (1240px) is for the calendar grid only. A wide shell is not permission to let prose run wide — cap the text, not the container.
- Every page keeps one left edge. A row or block with its own padding pulls back by the same amount (`margin-inline: calc(var(--s-4) * -1)`) so its content lines up with the heading above it rather than creating a second, slightly-indented edge.
- Every button resolves to one geometry: `--control-h`, `--control-pad-y`, `--control-pad-x`, pill radius, `--t-callout`. Variants change colour only, never size or padding.
- One font family (`--font`) and one type scale (`--t-*`) across the whole app. No second display face, no monospace — use `font-variant-numeric: tabular-nums` for figures.
- Keep UI copy factual. Labels, states and counts only; no encouraging or narrative microcopy.
- UI chrome has no decorative gradients or drop shadows, and only product imagery may use `--shadow-product`.
- New interactive controls must include visible keyboard focus, at least a 44px touch target, active feedback, and reduced-motion support.
- Keep production HTML, CSS, and JavaScript separate. Files under `prototypes/` are reference-only.

## AI providers

- Providers are registered per role (`transcription`, `note`) in `providerRoles` in `server.mjs` and `providerCatalog` in `assets/js/app.js`. Credentials are keyed `role:provider`, so a provider that serves two roles keeps two independent keys and models.
- API keys never reach browser JavaScript. They are verified against the provider, encrypted with AES-256-GCM, and stored in `.data/`. Verify against an endpoint that actually authenticates — OpenRouter serves its catalogue publicly, so `/api/v1/key` is the check there.
- The note prompt in `server.mjs` is a contract, not a suggestion: AI may repair grammar and structure but must never add, remove, summarise or translate. Change it only with that constraint in mind, and keep the title-vs-continuation split so multi-chunk lectures do not grow several headings.
- Derived AI output is regenerated deliberately, never automatically — it costs the student money. Notes store a fingerprint of the transcript they came from so a stale note can be reported instead of silently shown.
- Provider setup is a three-step ladder (key → model → ready) and `providerStage()` is the single source of truth for how far along a provider is; the row chip, the section summary and the step marks all read from it. Never report a state change only in text: the step that changed must scroll into view, mark itself done, and announce a toast. Choosing a model saves and activates it — do not reintroduce a separate confirm button.
