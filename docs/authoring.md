# Data authoring guide (Fantasy Art Brief Generator)

You are writing the random tables that produce short, dense, highly visual fantasy **art briefs** for a concept artist. Quality bar: every entry should make an artist *see* something — shape, material, colour, light, texture, silhouette. No stats, no lore dumps.

## Hard rules (the validator enforces these)
Run `npx tsx scripts/validate-data.ts --only <your table ids or category>` from the repo root (`~/Downloads/art-brief`) until your part reports OK. Do not edit files you were not assigned. Do **not** edit `data/tags.json`, `data/themes.json`, `data/categories/*`, `schema/*` or `scripts/*` — if you truly need a new tag, say so in your final report instead and use the closest existing tag.

- JSON only, 2-space indent. Table file shape:
  ```json
  { "id": "creature.adaptation", "category": "creature", "slot": "adaptation", "entries": [ ... ] }
  ```
  `id` must be `<category>.<slot>`, the file lives at `data/<category>/<slot>.json`.
- Entry fields: `id` (kebab-case, unique in the table), `text` (required), and optionally `label`, `weight` (integer 1–10, omit when 5), `tags`, `themes`, `requires`, `excludes`, `surreal`, `tier`, `group`. No other fields.
- `text` ≤ 90 characters (aim for ≤ 55), lowercase start unless a proper noun, **no trailing punctuation**, no double spaces.
- **No gendered pronouns** (he/his/she/her…). Use "their", "its", or rephrase.
- Correct a/an ("an owl", "a unicorn", "an hour").
- Tags must come from `data/tags.json`. Theme ids must come from `data/themes.json`.
- Write original phrases. D&D flavour is wanted — SRD names plus iconic names like beholder, mind flayer, warforged, Feywild, Shadowfell, Sigil, Underdark, Forgotten Realms flavour — but never copy sourcebook descriptions.

## How the engine uses your fields
- **themes**: list of theme ids the entry suits. **Empty or missing = fits every theme** (use this for generic entries — you need plenty of them). An entry is also on-theme if one of its `tags` is in the theme's `allowTags`.
- **Theme ids**: `high-fantasy, dark-fantasy, infernal, celestial, fey, undead, elemental-fire, frost, nautical, underdark, arcane, wild-primal, planar`.
- **allowTags / blockTags** per theme (from themes.json):
  | theme | allowTags | blockTags |
  |---|---|---|
  | high-fantasy | noble, heroic, arcane, radiant, pastoral | necrotic, grotesque |
  | dark-fantasy | grim, cursed, gothic, blood, ruin | whimsical |
  | infernal | fire, fiend, contract, brimstone, chains | celestial, fey |
  | celestial | radiant, holy, feathered, gold, astral | necrotic, fiend |
  | fey | fey, glamour, flora, trickster, twilight | infernal, industrial |
  | undead | necrotic, bone, grave, shadow, gothic | radiant, holy |
  | elemental-fire | fire, ash, magma, forge | frost, water |
  | frost | frost, glacier, north, rune | fire, tropical |
  | nautical | water, coral, pirate, abyssal, storm | desert |
  | underdark | subterranean, fungal, drow, aberration, crystal | sky, radiant |
  | arcane | arcane, clockwork, library, astral, rune | — |
  | wild-primal | beast, tribal, storm, jungle, druidic | urban, clockwork |
  | planar | planar, portal, surreal, astral, guild | — |
- An entry carrying a **blockTag** of the current theme is removed in Grounded/Mixed modes. So only tag an entry `fire`, `holy`, `radiant`, `necrotic`, `fiend`, `fey`, `celestial`, `water`, `frost`, `sky`, `urban`, `clockwork`, `industrial`, `whimsical`, `grotesque`, `desert`, `tropical`, `infernal` when you mean it.
- **Coverage rule (validator):** for every theme, each required slot needs ≥ 3 entries that are on-theme, not blocked, and not surreal. The category's primary slot and the palettes need ≥ 6. The easy way: make ~40–50% of every table theme-free (no `themes`, no block-prone tags) and spread the rest across themes.
- **tags** do three jobs: theme fit (allowTags), `requires`/`excludes` checks, and a soft *affinity* bonus — an entry sharing a tag with something already picked for the same brief gets extra weight (e.g. an outfit tagged `martial` is favoured for a fighter).
- **requires** = any-of: the entry is only allowed if at least one listed tag was provided by an **earlier** slot (slot order is in `data/categories/<cat>.json`) or by the category base tags. Use sparingly — for real structural needs ("wing-membrane sails" requires `winged`).
- **excludes**: the entry is removed if any listed tag is in the brief so far (and vice versa). Only for true readability conflicts ("grasping talons" excludes `limbless`).
- **surreal: true** marks impossible/dreamlike entries (never shown in Grounded, common in Wild).
- **weight** 1–10: default 5; use 2–3 for rarer oddities, 7–8 for staples.
- **label**: short Title Case name used inside the title line (required where noted).

## Tag vocabulary (data/tags.json)
- theme: noble heroic arcane radiant pastoral necrotic grotesque grim cursed gothic blood ruin whimsical fire fiend contract brimstone chains celestial holy feathered gold astral fey glamour flora trickster twilight infernal industrial bone grave shadow ash magma forge frost water glacier north rune tropical coral pirate abyssal storm desert subterranean fungal drow aberration crystal sky clockwork library beast tribal jungle druidic urban planar portal surreal guild
- environment: swamp forest mountain plains ocean coast island volcanic arctic cavern city village wilderness river ruins temple court market road
- light: night day dawn dusk moonlit sunlit dark luminous
- palette: warm cool muted vivid pastel earthy metallic monochrome jewel
- mood: serene eerie festive melancholy violent mysterious romantic comic
- body: winged legged limbless multi-limbed amorphous tentacled shelled furred scaled horned tusked construct plant gaseous aquatic quadruped biped serpentine insectoid
- size: tiny small medium large huge
- species: humanoid elf dwarf halfling gnome orc dragonborn tiefling aasimar goblinoid giantkin birdfolk catfolk reptilian
- culture: culture-elven culture-dwarven culture-infernal culture-orcish culture-fey culture-human culture-draconic culture-gnomish
- role: martial divine primal stealth performer tinker scholar caster
- class: class-artificer class-barbarian class-bard class-cleric class-druid class-fighter class-monk class-paladin class-ranger class-rogue class-sorcerer class-warlock class-wizard
- object: weapon instrument relic tool container jewellery book worn held armour
- creature-type: dragon elemental giant monstrosity ooze undead
- material: metal wood stone cloth leather glass organic gem liquid ethereal
- category (base tags, provided automatically): cat-character cat-prop cat-creature cat-building cat-scene animate inanimate place

## How each table renders (write so the sentence reads well)
Aim for **15–25% above the minimum count** in every table.

### Character (`data/character/`) — slot order: species, class, subclass, background, look, outfit, material, pose, palette, traits, unique, name
Example brief:
```
Orrin Vale — Firbolg Circle of Spores Druid
Background: exiled grave-tender
Look: towering, mossy blue-grey skin, lichen creeping along the jaw
Wearing: robe of woven fog stitched to candle-wax beads
Pose: kneeling, cupping a glowing mushroom like a lantern
Traits: gentle, unsettlingly patient
Unique: spores drift upward from their footprints
```
- `species.json` (min 20): `label` "Firbolg"; `text` = body silhouette + skin/fur/scale, ≤ 40 chars ("towering, mossy blue-grey skin"). Tags: body tags (furred/scaled/feathered/horned/tusked/construct), size, species group, and **exactly one culture-* tag** (drives name generation). Include SRD species plus tiefling, aasimar, firbolg, tabaxi, warforged, goliath, kenku, genasi, tortle, etc. Primary slot → ≥ 6 per theme: keep ~9 species theme-free.
- `class.json` (13 incl. artificer): `label` "Druid", `text` a short visual phrase of the archetype. Tags: exactly one `class-*` + role tags. **No themes.**
- `subclass.json` (≥ 39, 3+ per class): `label` reads between species and class in the title — "Circle of Spores", "Battle Master", "Oath of Devotion", "College of Whispers", "Way of Shadow", "Armorer". `requires: ["class-druid"]` (exactly one class tag). Tags: role tags only. **No themes, no block-prone tags.**
- `background.json` (min 20): "exiled grave-tender", "disgraced court astronomer".
- `look.json` (min 40): a detail appended after the species text: "lichen creeping along the jaw", "a scar splitting one eyebrow". Most entries generic; use `requires`/`excludes` with species tags where a detail only fits some bodies (e.g. "braided beard" excludes construct/birdfolk/scaled… or better, requires dwarf/humanoid). Keep ≥ 60% without requires.
- `outfit.json` (min 40): garment/armour phrase that reads before "of <material>": "long hooded robe", "scale hauberk", "patchwork travelling coat", "sleeveless harness". Never name the material. Tag with role tags for affinity.
- `pose.json` (min 30): body position + action: "kneeling, cupping a glowing mushroom like a lantern". Role tags optional.
- `traits.json` (min 40): single adjectives or 2-word phrases ("gentle", "unsettlingly patient"). Every trait has a `group`; opposites share a group ("brave" / "timid" both `group: "courage"`). Two traits are joined with a comma; they are never picked from the same group.
- `unique.json` (min 20, category-specific unique traits): predicate phrase with no subject, "Unique: " is prefixed: "spores drift upward from their footprints", "their reflection is always a few years older". `tier`: minor (~40%), notable (~35%), legendary (~25%).

### Prop (`data/prop/`) — order: objectType, material, origin, function, details, palette, unique, name
```
The Quiet Crown — circlet of frozen lightning set in honeyed iron
Origin: storm-giant court
Function: silences every sound within ten feet of the wearer
Details: hairline cracks glow when someone nearby lies
```
- `object.json` (min 35): `text` lowercase noun phrase **without material** ("circlet", "long-hafted glaive", "hand drum", "reliquary box"); `label` Title Case noun used in the item name ("Crown", "Glaive", "Drum", "Reliquary"). Tags: one or two object tags (weapon instrument relic tool container jewellery book worn held armour). Mix weapons, instruments, relics, tools, containers, jewellery, books. Primary slot → mostly theme-free.
- `origin.json` (min 15): culture/place of make: "storm-giant court", "drow matriarchy", "gnomish guild". Tag a matching culture-* where natural (used for names like "Thrain's Lantern").
- `function.json` (min 35): magic effect, verb phrase in present tense starting with a verb: "silences every sound within ten feet of the wearer", "burns cold instead of hot". Tag with object tags it suits (weapon/worn/container…) for affinity — no requires.
- `details.json` (min 25): physical wear/detail: "hairline cracks glow when someone nearby lies", "grip wrapped in faded prayer ribbons".
- `unique.json` (min 20): as character, phrased for an object: "grows warm when pointed toward treasure".

### Building (`data/building/`) — order: function, style, material, condition, setting, feature, light, palette, unique, name
```
Library of the Last Tide — archive, drowned-baroque style
Built of: petrified coral veined with stitched shadow
Condition: half-flooded, still in use
Setting: island in an Underdark cavern lake
Signature feature: reading rooms inside giant air bubbles
Light: blue bioluminescence rising from below
```
- `function.json` (min 25): `text` lowercase ("archive", "lich tower", "tavern"); `label` Title Case noun for the name ("Library", "Spire", "Tavern"). Tags e.g. temple/market/library/court. Primary slot → mostly theme-free.
- `style.json` (min 18): reads before " style": "drowned-baroque", "dwarven brutalist", "elven art-nouveau".
- `condition.json` (min 10): "half-flooded, still in use". Theme-free mostly.
- `setting.json` (min 18): "island in an Underdark cavern lake".
- `feature.json` (min 30): "reading rooms inside giant air bubbles".
- `light.json` (min 12): "blue bioluminescence rising from below".
- `unique.json` (min 20): phrased for a place/building: "its doors open onto a different street each dawn".

### Creature (`data/creature/`) — order: creatureType, bodyPlan, habitat, adaptation, behaviour, scale, palette, unique, name
```
Ashmaw Wader — fiend, long-necked quadruped
Habitat: volcanic salt flats
Adaptation: feet of cooled glass that ring on hot ground
Behaviour: moves in silent single-file herds at dusk
Scale: elephant-sized
Unique: its shadow always points toward the sun
```
- `type.json` (the 14 SRD types: aberration beast celestial construct dragon elemental fey fiend giant humanoid monstrosity ooze plant undead): `text` lowercase type name, `label` Title Case. Tags from creature-type/theme groups (undead → `undead` + `necrotic`; fiend → `fiend`; celestial → `celestial`; fey → `fey`; aberration → `aberration`…). Primary slot needs ≥ 6 grounded on-theme, unblocked per theme → leave beast, monstrosity, dragon, elemental, giant, plant, ooze, construct, humanoid theme-free (no themes).
- `body.json` (min 16): `text` lowercase body plan ("long-necked quadruped", "limbless serpent", "six-legged insectoid", "drifting jellyfish bell"); `label` Title Case noun for the name ("Wader", "Serpent", "Crawler", "Drifter"). Tags: body tags (winged/legged/limbless/multi-limbed/amorphous/tentacled/shelled/serpentine/quadruped/biped/insectoid/aquatic/gaseous/plant). Mostly theme-free.
- `habitat.json` (min 18): "volcanic salt flats". Environment tags.
- `adaptation.json` (min 35): "feet of cooled glass that ring on hot ground". Use `requires` (any-of) for body-dependent ones (feet → requires legged/quadruped/biped/insectoid; wings → winged) and `excludes` for conflicts (talons excludes limbless/amorphous). Keep ≥ 60% with no requires so every body plan has options.
- `behaviour.json` (min 20): "moves in silent single-file herds at dusk".
- `scale.json` (min 8, ideally 10): "cat-sized" … "cathedral-sized". No themes.
- `unique.json` (min 20): "its shadow always points toward the sun".

### Scene (`data/scene/`) — order: location, time, event, composition, mood, palette, unique, name
```
The Name Market
Location: rope-bridge market strung across a moonlit fey gorge
Time & weather: twilight, pollen falling like snow
Event: a hag haggles with a young squire over a jar of stolen names
Composition: low angle from beneath the bridge, lanterns framing the pair
Mood: whimsical but wrong
```
- `location.json` (min 30): full visual location phrase; `label` Title Case noun used in the title "The <Word> <Label>" ("Market", "Bridge", "Crossing", "Shrine"). Primary slot → mostly theme-free.
- `time.json` (min 20): "twilight, pollen falling like snow".
- `event.json` (min 30): contains `{a}` and optionally `{b}` — replaced by actors **with the article added automatically**: "{a} haggles with {b} over a jar of stolen names" → "a hag haggles with a young squire…". Never write the article before {a}/{b}.
- `actors.json` (min 30, file `data/scene/actors.json`, id `scene.actors`): noun phrases **without** article: "hag", "young squire", "armoured owlbear", "drow envoy".
- `composition.json` (min 15): camera angle + focal point, generic enough to fit any event: "low angle, figures silhouetted against a torn sky".
- `mood.json` (min 15): "whimsical but wrong".
- `unique.json` (min 20): phrased for a scene: "every shadow in the scene points at the same figure".

### Shared
- `data/materials.json` (id `shared.materials`, category `shared`, slot `materials`; min 80, **≥ 40 with `"surreal": true`**, aim ~48 surreal / ~45 mundane). Text reads after "of": "blackened steel", "frozen lightning", "honeyed iron", "woven moonlight". Material group tags (metal wood stone cloth leather glass organic gem liquid ethereal) + theme tags. No requires/excludes. Two materials may be fused: "frozen lightning set in honeyed iron", so short phrases (≤ 30 chars) work best. Each theme needs ≥ 3 non-surreal on-theme materials. Starter surreal list: frozen lightning, petrified song, woven moonlight, candle-wax bone, liquid obsidian, glass that bleeds, blooming rust, stitched shadow, honeyed iron, fossilised smoke, solid echo, dragon-sweat amber, starlight lacquer, weeping marble, cloud felt, chained fire, dreaming clay, bottled dusk, silver rain wire, memory silk.
- `data/palettes.json` — `{ "palettes": [ { "id", "name", "hex": [4–5 × "#RRGGBB"], "tags", "themes" } ] }`, min 50 (aim 58). Name 1–3 evocative Title Case words ("Bog Lantern", "Stormglass"). Order hex dark → light; make them genuinely usable art palettes (value range from near-black to a light accent, coherent hue family, one accent). Tags from palette/light/mood/theme groups. **Every theme needs ≥ 6 palettes** on-theme (themes list, or allowTag in tags, or theme-free) and not blocked.
- `data/unique-shared.json` (id `shared.unique`, category `shared`, slot `unique`; min 60, aim 70). Shared across categories, so use `requires` (any-of, from base tags) to limit phrasing: `["animate"]` (characters & creatures), `["inanimate"]` (props & buildings), `["place"]` (buildings & scenes), or a single `cat-*`. Leave requires empty only if the phrase works for all five categories. `tier` minor ~40% / notable ~35% / legendary ~25%. Mostly theme-free.

### Names (`data/names/`)
- One file per culture: `elven.json dwarven.json infernal.json orcish.json fey.json human.json draconic.json gnomish.json`, shape `{ "id": "elven", "culture": "culture-elven", "prefixes": [...≥ 22, Capitalised], "suffixes": [...≥ 22, lowercase], "family": [...≥ 22, Capitalised surnames/bynames] }`. Name = prefix + suffix (+ optional family): "Orrin Vale". Make every prefix×suffix combo pronounceable (watch doubled/clashing letters).
- Word tables in `data/names/words/` (standard table format, category `shared`):
  - `item-adjective.json` (id `shared.item-adjective`, min 40): single Title Case word for "The <Adj> <Label>" — "Quiet", "Hollow", "Last". Themed where flavourful.
  - `creature-first.json` (min 30) + `creature-second.json` (min 30): halves of a creature name: "Ash"+"maw" → "Ashmaw", then the body label: "Ashmaw Wader". First halves Capitalised, second halves lowercase. Themed.
  - `building-epithet.json` (min 40): for "<Label> of the <Epithet>" — Title Case 1–3 words: "Last Tide", "Hollow Crown", "Ninth Bell".
  - `scene-word.json` (min 40): single Title Case word for "The <Word> <Label>" — "Name", "Lantern", "Ember".
  - For word tables the `text` is the word itself (capitalisation as described; the lowercase-start rule does not apply).
