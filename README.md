# Dashboards Hub

Landing page that links every reporting dashboard — the main entry point of the
suite. Same design system as its siblings (Inventory / Purchasing / Material
Aging), static, no build step.

## What it is

One page, one card per dashboard: title, byline, the dashboard's own last data
refresh stamp, and a link to the dashboard.

The hub owns the **only** login form in the suite. Each dashboard is gated by
Supabase (`app_metadata.dashboards` allowlist) but shows no login form: it adopts
the session the hub hands over and re-checks its own allowlist entry.

## Interaction and polish notes

These are deliberate; don't "simplify" them away.

- **The whole card is clickable.** A single stretched anchor (`.card-hit`,
  `position:absolute; inset:0`) covers each card, so there is one tab stop per card
  instead of a nested duplicate link. The visible call-to-action (`.btn.cta`) is a
  decorative `aria-hidden` span with `pointer-events:none`. Verified with
  `elementFromPoint`.
- **Card text is clamped to fixed line counts** (byline 2, description 3). Without
  the clamps a longer wrap pushes one card's pill row and buttons ~19px below its
  neighbours. If you edit `desc` in `build_hub.py`, keep it short enough not to clip
  at the narrowest 3-column width.
- **Button labels are contrast-derived, not hard-coded.** `build_hub.py` picks each
  card's `ink` by walking `INK_CANDIDATES` for the first colour that clears WCAG AA
  (4.5:1) against that card's accent, and **fails the build** if none does. White on
  the amber accent is only 2.03:1 — unreadable. The fill is the inline `--card-accent`,
  which does not change with the theme, so a single `ink` covers both themes.
- **Focus is styled.** Chrome's default ring is near-black (~1.2:1) and invisible on
  this background, so `:focus-visible` draws a 2px accent ring.
- **Icons are one SVG set**, 2px stroke, `currentColor`, `aria-hidden`. No emoji —
  they render differently per platform and clash with the monochrome system. The
  theme toggle cross-fades sun/moon (both in the DOM) at the standard
  `opacity` / `scale(0.25→1)` / `blur(4px→0)` values.
- **Transitions name their properties** (never `transition: all`), and
  `prefers-reduced-motion` drops movement while keeping the colour cues.
- **Hit areas**: 40×40 minimum on desktop, 44×44 under 640px.


## Files

| File | Purpose |
|------|---------|
| `index.html` | Layout: topbar, hero, card grid, notice, footer |
| `styles.css` | Same design tokens as the sibling dashboards (dark + light) |
| `app.js` | Renders cards from `data/hub.js`; theme toggle (`hub-theme`) |
| `data/hub.js` | Generated payload (`window.__HUB__`) — card list + refresh stamps |
| `data/build_hub.py` | Regenerates `data/hub.js` from the sibling exports |
| `assets/logo.png`, `assets/favicon.ico` | Branding (copied from the dashboards) |
| `CNAME` | `dashboard.abederp.com` |

## Refresh the refresh-dates

```bash
cd "C:/Users/c.crizaldo/OneDrive - Ahmad A. Abed Trading Co. Ltd/Documents/Dashboards/dashboard"
python data/build_hub.py
```

It reads `generated_at` from the head of each sibling export
(`inventory/data/inventory.json`, `purchasing/data/purchasing.json`,
`aging/data/material_aging.json`) — nothing is hard-coded. Then bump the two
`?v=` cache-busters in `index.html`.

## Add a dashboard

Append an entry to `DASHBOARDS` in `data/build_hub.py` (order, id, authId,
title, byline, desc, local, accent, icon, stamp_file), re-run the script, done.

## Deploy (GitHub Pages)

This folder IS the repo root — Pages serves it as one origin:
`dashboard.abederp.com` serves the hub at `/` and each dashboard at `/<id>/`
(`/inventory/`, `/purchasing/`, `/aging/`). No external subdomains, sessions
live in the same localStorage.

- The `CNAME` file at this root is what Pages honors (`dashboard.abederp.com`).
- Keep the hub's `index.html` at the repo root — Pages only serves `index.html`
  at the root (or per-folder `index.html` for each `/<id>/` path, which the
  dashboards already provide).
- Requires a DNS record for `dashboard` (currently NXDOMAIN) plus the same
  Cloudflare proxy setup the other subdomains use.

## Run locally

Serve this repo root (the hub links to its siblings by relative path), or
double-click `index.html`:

```bash
cd "C:/Users/c.crizaldo/OneDrive - Ahmad A. Abed Trading Co. Ltd/Documents/Dashboards/dashboard"
python -m http.server 8099
# http://localhost:8099/
```

For the four-port cross-origin harness (one server per site, exercises the
fragment hand-off), run each folder on its `HARNESS_PORTS` port
(`hub` 8090, `aging` 8091, `inventory` 8092, `purchasing` 8093) and open
`http://localhost:8090/?crossorigin=1`.
