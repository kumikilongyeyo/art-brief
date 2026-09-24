# Lore authoring guide

Every card can show a 50–80 word **story** built from its own lines, told in four beats. The reference
implementation is **Prop** — read `data/prop/lore-*.json` before writing anything; match its length and style.
Also read `docs/authoring.md` (tags, themes, tone) and the header comment of `src/engine/lore.ts` (placeholders).

## Files
`data/<category>/lore-origin.json`, `lore-purpose.json`, `lore-turn.json`, `lore-now.json` — standard table
format, id `<category>.lore-<beat>`. Each entry `text` is one sentence (occasionally two) **without the final
full stop** (the engine adds it and capitalises the first letter). Max 170 characters.

## Why the story exists
Briefs list strange, unrelated facts (a staff of *bottled dusk and shed antler* that *lulls beasts*, with *a pale
handprint*). The story **explains them**: who made/was it, what for, what went wrong, where it is now. Across its
four beats a story should use **at least three of the card's lines**, and the details/unique lines should read as
*evidence* of the turn. End with a hook — something a party could go and do.

## Hard rules (validator + tests enforce most of these)
- **Length:** fixed words (not counting placeholders) ≤ 10 per beat; at most 3 placeholders per beat. Check with
  `npx tsx scripts/lore-stats.ts <category>` → aim for median 60–70, **zero over 80, zero under 50**.
- **Counts:** each beat ≥ 16 entries: ~5 theme-free at `"weight": 4`, plus ≥ 1 per theme at `"weight": 8`
  (13 themes). The theme-weighted ones make the **tone follow the theme** (Dark Fantasy grim, Fey whimsical-
  but-wrong, Infernal contracts and prices, Celestial blessings and judgement, Undead graves and the dead, Nautical
  storms and tides, Underdark dark and alien, Arcane scholars and failed spells, Wild/Primal hunts and clans,
  Frost ice and long winters, Elemental Fire forges and ash, High Fantasy heroes and dragons, Planar portals and
  Sigil). Weirdness never changes the voice.
- **{unique}**: entries using it must have `"requires": ["has-unique"]`; entries without it must not. In
  `lore-now` every theme needs ≥ 3 entries that do *not* need a unique trait.
- **{npc}**: introduces the story's figure ("a river witch named Ceda") on first use, then just the name. Never
  write `{npc}'s`. `{npcname}'s` is fine anywhere (it becomes "its maker's" etc. before the introduction).
- **{place}** is any of ~30 very different places ("an auction house in Neverwinter", "the stomach of a purple
  worm", "a bazaar stall in Sigil"): the sentence must work with **every** one. Use `in {place}`, never a verb
  that assumes a kind of place ("buried in", "sails into").
- **{era}** is an adverbial time phrase ("three hundred winters ago", "long before the Spellplague") — works at the
  start of a sentence or after a clause.
- No gendered pronouns. Characters are *they/their* or `{first}`; everything else is *it/its*.
- Past tense for origin/purpose/turn; `lore-now` in present tense. **Scene is different** (see below).
- Correct a/an is automatic for `{a:…}`, `{al:…}` and `{npc}` — never write an article in front of them.
- Original wording, D&D flavour (Waterdeep, Baldur's Gate, Sigil, the Shadowfell, the Underdark, Avernus are fine).

## Placeholders
`{f:slot}` field text · `{the:slot}` with "the" (skipped for proper nouns) · `{a:slot}` with a/an ·
`{al:slot}` the short label with a/an ("an Elf") · `{l:slot}` label · `{its:slot}` / `{their:slot}` replace a
leading article · `{name}` card title name · `{first}` (character) first name · `{subj}` who a predicate attaches
to · `{unique}` the unique trait as a full clause · `{wearing}` `{traits}` (character) · `{npc}` `{npcname}`
`{place}` `{era}`.

## How each field reads — use the frame that fits its grammar
Noun/participle phrases that sometimes lack an article (look, details, condition, setting, time) go in an
**appositive after a comma**: "it came back changed, *polished to a mirror sheen on one face only*" — works for
"a notch filed for every life" and "soot packed into every crevice" alike. Never "the {f:details}".

### Character — slots: species class subclass background look outfit material pose palette traits unique name
Beats: **origin** = where they came from (background, species) · **purpose** = how they found their calling
(class/subclass) · **turn** = what marked them (look as evidence, or wearing) · **now** = what they want, hook
(traits, unique).
- `{first}` / `{name}` ("Orrin" / "Orrin Vale"); `{al:species}` → "a Firbolg"; `{l:class}` "Druid";
  `the {l:subclass}` → "the Circle of Spores", "the Oath of Devotion", "the Fiend Pact".
- `{a:background}` → "an exiled grave-tender", "a lamplighter from a city of permanent fog".
- look: appositive — "…and it left a mark, {f:look}".
- `their {wearing}` → "their long hooded robe of polished jet".
- pose: participle — "…which is how you find them now, {f:pose}".
- `{traits}` → "gentle and unsettlingly patient": "{first} grew up {traits}".
- `{unique}` → "their eyes glow faintly in total darkness" / "Orrin smells of rain on hot stone".
- The `{npc}` here is a second figure — mentor, rival, patron, debt-holder.

### Creature — slots: creatureType bodyPlan habitat adaptation behaviour scale palette unique name
Beats: **origin** = how the kind came to be (type, habitat) · **purpose** = how it survives (adaptation,
behaviour) · **turn** = the legend or encounter everyone tells · **now** = where it is / what it wants, hook.
- `{name}` "Ashmaw Wader"; `{l:bodyPlan}` "Wader"; `{f:creatureType}` "fiend"; `{f:bodyPlan}` "long-necked quadruped".
- `{the:habitat}` → "the volcanic salt flats", "the blue glacier crevasses".
- adaptation is a noun phrase: "its kind grew {f:adaptation}", "it evolved {f:adaptation}".
- behaviour is a verb phrase: "it {f:behaviour}" ("it moves in silent single-file herds at dusk").
- `{f:scale}` is an adjective ("elephant-sized", "long as a war galley"): "a thing {f:scale}" is risky — prefer
  appositive: "…one of them, {f:scale}, …".
- `{unique}` → "its shadow always points toward the sun". `{npc}` = a hunter, scholar, shepherd, survivor.

### Building — slots: function style material condition setting feature light palette unique name
Beats: **origin** = founding (who, when, where) · **purpose** = what it was for (feature, material) ·
**turn** = what happened to it (condition as evidence) · **now** = today (light, unique), hook.
- `{name}` "Library of the Last Tide"; `{a:function}` "an archive"; `{l:function}` "Library".
- `{f:style}` reads before "style": "built in the {f:style} style".
- `built of {f:material}` → "built of petrified coral veined with stitched shadow".
- setting has mixed prepositions ("on the back of a dragon turtle", "island in an Underdark lake"): appositive
  only — "{npc} raised it in an odd spot, {f:setting}".
- `{its:feature}` → "its moat of slow-moving quicksilver".
- condition: "Today it stands {f:condition}" or appositive.
- light: "bathed in {f:light}" or appositive.
- `{unique}` → "its doors open onto a different street each dawn" / "it rests on a sleeping earth elemental".
  `{npc}` = founder, architect, first abbot, lich, guildmaster.

### Scene — slots: location time event composition mood palette unique name
A scene is a single moment, so its story is **before → why they came → the moment → what happens next**.
**origin/purpose in past tense, turn and now in present tense.**
- `{name}` "The Name Market"; `{the:location}` → "the rope-bridge market strung across a moonlit fey gorge".
- time: appositive — "It happens at the worst possible hour, {f:time}".
- event is a complete present-tense clause with its actors ("a hag haggles with a young squire over a jar of
  stolen names"): use it as its own sentence or after a colon — "And now, {f:event}", "This is the moment:
  {f:event}". Never "when {f:event}" in past tense.
- mood: "…and everyone there will remember it as {f:mood}" ("as a bitter victory", "as romantic and doomed").
- `{unique}` clauses are about the place: "every candle burns with a green flame". `{npc}` = a witness, the one who
  arranged the meeting, the one who never arrived.

## Workflow
1. Write the four files for your category.
2. `npx tsx scripts/validate-data.ts --only <category>.lore` until clean.
3. `npx tsx scripts/lore-stats.ts <category>` until median 60–70, 0 over 80, 0 under 50.
4. `npx tsx scripts/sample-briefs.ts <category> 4` and **read every story**. Fix anything awkward: broken
   grammar at a placeholder seam, a story that ignores the card, a tone clash, a repeated shape.

---

# Plot spines and the hook card (v1.3)

Every story now rolls a **plot spine** first (`data/lore/spine.json`):
**stolen · cursed · bargain · betrayed · lost · awakened · guardian · prophecy**.
`origin` and `purpose` stay generic (they set up the card). **`turn` and `now` are told from the spine**, so the
story builds to one plot: the turn is the spine's defining event, the now is that plot's consequence + hook.

Each spine-driven line carries `"spines": [...]` (one or more spine ids it genuinely fits). The engine only picks
lines for the rolled spine.

| spine | turn = the event | now = consequence / hook |
|---|---|---|
| stolen | it (or something of theirs) was taken, by whom | it is out there, being fenced / hunted / used |
| cursed | the curse took hold, why | the curse's price today; how it might be broken |
| bargain | a deal was struck with a devil / archfey / god / guild | the debt comes due; who holds the contract |
| betrayed | someone trusted turned | the betrayer prospers; revenge is waiting |
| lost | it vanished — shipwreck, war, a portal, an avalanche | where it lies; who is searching |
| awakened | something inside woke up / came back | it acts on its own now; it wants something |
| guardian | it was set to guard or protect something | what it still guards; what happens if it fails |
| prophecy | a prophecy named it / them | the prophecy is close; who wants it fulfilled or stopped |

## Hook card (shown under the story, D&D job-board style)
- **Rumour** — `data/<category>/lore-rumour.json`, `"spines"` required. What tavern folk *say* — in-world
  speech, ≤ 25 words, first person or hearsay, may be wrong or half-true ("My cousin swears it hums when a liar
  speaks"). Rendered inside quotes; no final full stop needed. Use card placeholders as in the story.
- **Job** — `data/lore/job.json` (shared). What the party is hired to do, imperative, ≤ 16 words: "Recover {obj}
  before the new moon", "Find who broke the seal". Category-neutral placeholders only: `{name} {subj} {obj}
  {poss} {npc} {npcname} {place} {era}`. Use `"excludes": ["cat-scene"]` etc. when a line can't fit a category
  (a scene can't be "carried"). Every spine needs ≥ 3 usable lines **per category**.
- **Patron** — `data/lore/faction.json`: who hires the party. Noun phrase *with* its article/title: "the
  Harpers", "the Zhentarim", "a Red Wizard of Thay", "House Thann of Waterdeep", "the Doomguard of Sigil",
  "the Emerald Enclave", "the Church of Tyr". Theme-tagged.
- **Reward** — `data/lore/reward.json`: noun phrase: "500 gp", "a +1 weapon of the party's choice", "a favour
  from a noble house", "the location of a dragon's hoard", "passage on a spelljammer". Theme-tagged.
- **Twist** — `data/lore/twist.json` (shared, `"spines"` required): the DM-only secret complication, one
  sentence ≤ 20 words, shown behind a *Reveal* button: "The client is a doppelganger", "The curse moves to
  whoever returns {obj}", "{npcname} never died". Same placeholder rules as Job.

## Coverage rules (validator)
- `turn`: for every spine and every theme ≥ 3 grounded on-theme lines. `now`: ≥ 3, of which ≥ 2 without a
  unique trait. `rumour`: ≥ 2. Easiest: ≥ 3 theme-free lines per spine, then themed flavour on top (weight 8).
- `job` / `twist`: ≥ 3 lines per spine usable for each category.
- Story length rules are unchanged (50–80 words, median 60–70 via `scripts/lore-stats.ts`).
- Keep the rest of this guide's rules: appositives for noun fields, `{place}` fits any place, no `{npc}'s`,
  no gendered pronouns, original wording.
