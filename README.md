# Art Brief — Fantasy Art Brief Generator

One-screen tool that answers “What do you want to create?” with short, dense, D&D-flavoured art briefs
(Character, Prop, Creature, Building, Scene). Static site, works offline, installable, $0 to run.

**Live:** https://kumikilongyeyo.github.io/art-brief/

## Use
- Pick a category, theme, variations (1–4) and weirdness → **Generate** (or press Enter / Space).
- 🔒 lock a line to keep it on the next Generate; ↻ rerolls just that line (and lines that depend on it).
- **Lore** (tickbox, or *Add lore* on a card): a 50–80 word story built from the card's own lines, told in
  four beats with a tone that follows the theme. ↻ tells it differently; *Refine story in ChatGPT* copies a
  DM-style rewrite prompt. Story tables: `data/<category>/lore-*.json` — see `docs/lore-authoring.md`.
- **Copy for ChatGPT** wraps the brief in an art-director instruction (editable in Settings).
- **Link** copies a URL that recreates that exact card. Saved briefs live in this browser — use
  Settings → Export / Import to move them (the iPhone Home Screen app has its own storage).

## Develop
```bash
npm install
npm run dev          # http://localhost:5173/art-brief/
npm run validate     # data checks (runs in CI before the build)
npm test             # unit tests (Vitest)
npm run build && npx playwright test   # end-to-end (Chromium + WebKit, desktop + 390 px)
npx tsx scripts/sample-briefs.ts creature 3   # eyeball generated briefs
```

## Editing content
All tables live in `data/` as JSON. Read `docs/authoring.md` first — it explains tags, themes, the
coverage rules and how each table renders. Run `npm run validate` after any edit; a typo blocks the
deploy and the live site stays on the last good version. Bump `data/meta.json` `dataVersion` when
entries are renamed or removed, so old share links show the “older data” notice.

## Deploy
```bash
npm run deploy
```
Runs validate → lint → types → unit tests → build → e2e, and only if all pass publishes `dist/` to the
`gh-pages` branch (Pages serves it) and pushes `main`. Open the app afterwards and a
“New version — Refresh” pill appears.

To move this into GitHub Actions: give the GitHub token the `workflow` scope, move
`ci/github-actions-deploy.yml` to `.github/workflows/deploy.yml`, and set Pages → Source → GitHub Actions.
