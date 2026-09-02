# Repository instructions

## UI work

- Read `DESIGN.md` completely before creating or changing any UI.
- Treat `DESIGN.md` as the authoritative visual and interaction specification.
- Reuse the local tokens and primitives in `assets/css/design-system.css`; do not introduce ad-hoc colors, type scales, spacing, radii, shadows, or remote font/CDN dependencies.
- Use the bundled Inter files in `assets/fonts/inter/` as the non-Apple fallback. Keep SF Pro first in the font stack so Apple platforms use the native face.
- Preserve the photography-first, low-chrome language: Action Blue is the sole interactive accent, sections alternate light/parchment/near-black, UI chrome has no decorative gradients or drop shadows, and only product imagery may use `--shadow-product`.
- New interactive controls must include visible keyboard focus, at least a 44px touch target, active feedback, and reduced-motion support.
- Keep production HTML, CSS, and JavaScript separate. Files under `prototypes/` are reference-only.
