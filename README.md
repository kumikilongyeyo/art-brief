# Art Brief — Fantasy Art Brief Generator

One-screen tool that answers “What do you want to create?” with short, dense, D&D-flavoured art briefs
(Character, Prop, Creature, Building, Scene). Static site, works offline, installable, $0 to run.

**Live:** https://kumikilongyeyo.github.io/art-brief/

## Use
- Pick a category, theme, variations (1–4) and weirdness → **Generate** (or press Enter / Space).
- Every card reads like a **studio assignment**: a ticket header, the brief, then **Direction** (shape language,
  focal point, light & value from the palette, camera), **Deliverables** with a suggested time, and an **AD note**.
  Stories end with a **Moment to paint**.
- Optional **D&D details** (Settings, off by default): each card gets a **D&D stat tag** that agrees with it ("Weapon, very rare (requires attunement by a paladin)",
  "Large fiend, lawful evil · CR 7", "Level 12 · chaotic good", "Adventure site · Tier 2", "Encounter · Hard"), and
  every line shows the d100 roll it came from, DMG-table style.
- 🔒 lock a line to keep it on the next Generate; ↻ rerolls just that line (and lines that depend on it).
- **Lore** (tickbox, or *Add lore* on a card): a 50–80 word story built from the card's own lines. It rolls a
  D&D plot first (Stolen, Cursed, Bargain, Betrayed, Lost, Awakened, Guardian, Prophecy) and builds to it, with a
  tone that follows the theme. Under it, a hook card: Rumour · Job · Patron · Reward · a hidden DM Twist. ↻ tells it differently; *Refine story in ChatGPT* copies a
  DM-style rewrite prompt. Story tables: `data/<category>/lore-*.json` — see `docs/lore-authoring.md`.
- **Copy for ChatGPT** wraps the brief in an art-director instruction (editable in Settings).
- **Link** copies a URL that recreates that exact card.
- **Saved library** (☆ Saved button at the top): ☆ saves a card (into the folder you're viewing). Folder chips filter the list; 📁 moves a brief
  (or creates a folder in place), 🗑 removes it with Undo; drag a brief onto a chip on desktop. Deleting a folder
  moves its briefs to Unsorted. **History** has ☆ / × per item and *Clear history* — saved briefs are kept.
  Everything lives in this browser — Settings → Export / Import moves briefs *and folders* between devices.

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
