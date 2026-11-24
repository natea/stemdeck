# Design

## Context

See `proposal.md` for the motivation. What shapes the approach:

- **StemDeck has no harmony data.** There is no chord detection and no chord track. Per song it has one key (`Job.key`, `app/pipeline/analyze.py`), a bar grid (`stems/beats.json` plus user edits in `stems/beats.user.json`), sections from All-In-One (`Job.sections`), timeline tags, and, after transcription, note events per stem (`stems/transcription/<stem>.json`). Chord recognition is listed as out of scope in two open changes.
- **The player already does what a playalong needs.** `static/js/transport.js` has the A-B loop (`setLoopRange`), speed 0.5 to 1.5, transposition of plus or minus 6 semitones with drums left unpitched (`setGlobalPitch`), a metronome on the beat grid and a count-in in bars. The mixer has mute, solo and volume per stem.
- **The frontend is plain ES modules with no build step and no CDN.** Libraries are vendored in `static/vendor/`. Every string exists in ten languages and tests check that. Node unit tests live in `tests/js/`, Playwright specs in `tests/e2e/` selected by `tests/e2e/spec-map.json`.
- **There is no database.** Per-song state is JSON in the song folder; library-wide settings are `DATA_DIR/settings.json`; per-device state goes through `storeGet`/`storeSet`.
- **Views are either modes or overlays.** An overlay (the Visualizer, the Notation drawer) must leave the mix alone and hide while Karaoke or Performance is open. A mode owns the window and its own saved mix.
- **The source material is two copyrighted books.** The PDFs supplied are personal, watermarked copies. "LEGO" is a trademark the first book uses by special permission from the LEGO Group.
- **The books are firm that listening comes first and that there is no single correct analysis of a song.** That argues for an analysis the user can overrule and for drills that can hide everything written.

## Goals / Non-Goals

**Goals:**

- A harmony layer that needs nothing StemDeck does not already have: no new model, no new dependency, no network.
- Analysis that is instant, so editing a chart re-draws the roadmap as the user types.
- Each of three slices usable on its own: the map (chart, bricks, roadmap), the drills, the phrase collections.
- Brick names that can be swapped without touching stored data.

**Non-Goals:**

- Getting chords out of audio.
- Judging the user's playing (no pitch tracking of a live instrument).
- A different chart per chorus, reharmonisation suggestions, or scale and note-choice advice.
- A roadmap in the phone UI (`static/mobile/`).
- Chord symbols in alphaTab or in MusicXML, MIDI and Guitar Pro exports.

## Decisions

### 1. Chords come from the user as text

A chart is typed or pasted in a small text format (`[A] | D- G7 | CΔ | % |`), parsed in the browser, and saved as structured JSON.

- *Why:* chord recognition on jazz recordings is unreliable, would need a new model with its own licence and download, and would turn a harmony feature into a transcription-accuracy project. Typing 32 bars takes a couple of minutes, and both books treat writing out the changes as part of learning the song.
- *Alternative, audio chord recognition:* rejected for this change, named as the follow-up. The stored chart format is the target it would fill.
- *Alternative, iReal Pro import:* useful, but the format is an obfuscated URL scheme that needs its own parser and tests. Deferred.

### 2. The harmony engine runs in the browser; the server only stores

Chord parsing, the catalogue, analysis, transposition and drill generation are pure ES modules under `static/js/harmony/`. The backend validates and stores JSON.

- *Why:* the data is tiny (a chart is a few hundred bytes), analysis must re-run on every keystroke in the chart editor, it keeps working offline, and pure functions are cheap to test in `tests/js/`.
- *Alternative, a Python engine:* would let exports carry chord symbols, but nothing in this change consumes analysis on the server, and a round trip per edit makes the editor feel slow. If exports want chords later, the stored chart is enough for them; they do not need the analysis.
- *Consequence:* library-wide features (songs sharing a brick, the learning path) fetch every chart in one request and analyse them in the browser. At a few hundred songs this is a few milliseconds per chart; results are cached per chart version for the session.

Module layout:

| Module | Role |
| --- | --- |
| `harmony/chords.js` | Read a chord symbol into root, chord type, bass; spell it back in any key |
| `harmony/chartText.js` | Text to chart and chart to text |
| `harmony/chart.js` | Chart model, placement on the bar grid, "what is sounding at time t" |
| `harmony/catalogue.js` | Brick and join data |
| `harmony/analyse.js` | Chart to bricks, joins, hovers, home and away |
| `harmony/roadmap.js`, `roadmapView.js` | View model and DOM for the Roadmap overlay |
| `harmony/backing.js` | Synthesised bass, chords and click for drills |
| `harmony/drills/*.js` | One module per drill |
| `harmony/phrases.js` | Phrase collection and scale-degree view |
| `harmony/progress.js` | Progress record and learning path |

### 3. Storage follows the existing per-song JSON pattern

- `jobs/<id>/harmony/chart.json`: `{version, bars:[{chords:[{text, root, type, bass, beats}]}], sections:[{label, start_bar, length}], placement:{chorus_starts:[{bar, time}], end:{bar, time}}, corrections:[...]}`.
- `jobs/<id>/harmony/phrases.json`: `{version, phrases:[{id, name, stem, start, end, brick, key, chords, filed_by}]}`.
- `DATA_DIR/harmony_progress.json`: learned bricks and joins, last-practised times, recent quiz results.

Endpoints, all under `/api`:

| Method and path | Purpose |
| --- | --- |
| `GET/PUT/DELETE /jobs/{id}/chords` | The chart, placement and corrections for one song |
| `GET /harmony/charts` | Every chart in the library with song id and title |
| `GET/POST /jobs/{id}/phrases`, `PATCH/DELETE /jobs/{id}/phrases/{phrase_id}` | Phrases of one song |
| `GET /harmony/phrases` | Every phrase in the library |
| `GET/PATCH/DELETE /harmony/progress` | Practice progress |

- *Why one file for chart, placement and corrections:* they change together and a correction is meaningless without the chart it refers to.
- *Why chorus starts carry both a bar and a time:* the bar index is what the roadmap uses; the time is what survives a bar-grid edit. On load, if the grid has changed, each chorus start snaps to the bar nearest its stored time.
- *Why progress is on the server and not in `storeGet`/`storeSet`:* the spec asks for the same progress on every device that opens the library, and the browser store is per device.
- *Alternative, fields on `Job`:* sections and tags live there, but a chart with corrections is larger and changes more often than registry data should; the beat-grid files are the closer precedent.

### 4. The catalogue is data with stable ids, separate from display names

Each entry is `{id, family, formula:[{degree, type, optional}], rhythm, name}`. A formula is written relative to the root the brick comes to rest on, so it has no key. Larger blocks are lists of brick ids with the join between them. Joins are a table of twelve `{id, semitones, name}`.

- The first catalogue covers the bricks summarised in both books: roughly 27 cadences, 17 turnarounds, 7 dropbacks, 12 larger blocks and the 12 joins. They are entered by hand as formulas.
- *Why ids apart from names:* corrections, phrases and progress store ids. If the authors' names ever have to be replaced with neutral ones, it is a change to one table and its strings.
- *Why no prose per brick:* about 70 descriptions in ten languages is 700 strings to write and keep in step. The formula is the description. Prose exists only for the five families, the twelve joins and about ten concept terms (hover, home and away, launcher, dropback, pullback, tension ending and the like).
- Brick and join names are proper names and are not translated.
- "Homer" and "Retake" in the first book are the same distance used in two contexts. The catalogue has one join, Homer.

### 5. Analysis is a best-cover search over the chord sequence

1. **Normalise.** Each chord becomes `(root pitch class, type class, beats)`. Type classes are major, minor seventh, dominant, half-diminished, diminished, minor-tonic. Repeats merge into one event with a longer duration.
2. **Find candidates.** For each start position and each catalogue entry, test whether the next events match the formula for some resting root, allowing optional chords, the minor form, and harmonic rhythm at half, normal or double speed. A match records its span, resting root and form.
3. **Choose a cover.** Dynamic programming picks the non-overlapping set of matches that covers the chart at the lowest cost. Cost favours longer bricks, bricks that end on a bar that closes a row of four or eight, and larger blocks over their parts. Bars covered by nothing cost the most but are allowed, which is how unnamed stretches arise. Ties break by catalogue order so the result is deterministic.
4. **Hovers.** Any event longer than two bars, or exactly two bars that is not the resting chord of the brick before it, becomes a hover.
5. **Joins.** Wherever a brick ends at rest (major, minor-tonic, or a hover) and another brick follows, the join is the distance from that resting root to the first root of the next brick, looked up in the join table. No join is named after a brick that does not come to rest, such as a turnaround or a launcher, because the changes are simply carrying on. Bricks never span the end of the chart, and the join across the repeat is computed last.
6. **Home.** Each section's home is the resting root of its last cadence, falling back to the most common resting root weighted by bars. Every brick is then at home or away.
7. **Corrections.** User corrections are applied as fixed matches before step 3, so the search fills in around them.

- *Why a search and not left-to-right greedy matching:* greedy matching takes the first cadence it sees and then cannot recognise a pullback or a Pennies ending that contains it.
- *Prior art:* Impro-Visor (Bob Keller, Harvey Mudd College) has a roadmap feature built on these same two books; Keller is thanked in *Insights in Jazz*. Its published description is worth reading before implementing step 3. Impro-Visor is GPL software (confirm the version before relying on this): do not copy its brick dictionary or code unless the licence is confirmed compatible with this repository's AGPL-3.0-only. The catalogue here is entered from the formulas, which are facts.
- *Expected accuracy:* good on songs made of cadences and turnarounds, weaker on modal tunes, blues with dominant tonics, and heavy substitution. That is why corrections and unnamed stretches are first-class.

### 6. The Roadmap is an overlay drawn with DOM and CSS grid

A rail button with a Labs badge opens a panel over the studio, like the Visualizer and the Notation drawer. It leaves the mix alone and is hidden while Karaoke or Performance is open. Lines added outside `static/js/harmony/` are bracketed with `// harmony:begin` and `// harmony:end`, as the Visualizer does.

- *Why DOM and not canvas:* the roadmap is text in a grid. DOM gives keyboard focus, screen-reader labels, selectable text and a print stylesheet for the one-page landscape layout for free.
- Minor form, tension and away-from-home are shown with a text marker or border style as well as a colour token, so the view works in both themes and without colour vision.
- The highlight follows the same player clock the Notation view uses. Position to bar comes from the merged beat grid; bar to chart position comes from `chart.js`.
- Display key is a view setting: "as heard" (chart key plus the player's transposition), any of twelve keys, and concert, B flat or E flat instrument. Only chord spelling changes.

### 7. Drill backing is synthesised with Web Audio

`backing.js` schedules notes a short way ahead on the shared `AudioContext`:

- **Bass:** a filtered triangle wave, root on the first beat of each chord, with fifths and approach notes on the other beats.
- **Chords:** a three-note shell (root, third, seventh, with the altered note where the chord type has one) on a soft sine-plus-triangle tone.
- **Click:** the existing click presets from `clickSounds.js`.

The three parts have their own gain so the user can drop any of them. Starting a drill calls the transport's pause; the backing never passes through the stems' pitch bus or tempo stage.

- *Why not real instrument sounds:* a soundfont or sample set is megabytes to vendor or download, and alphaTab is vendored here without a soundfont. The backing only has to state the bass note and the chord quality clearly. The better-sounding playalong is the user's own library, which is what the "real examples" and "all keys on a recording" drills are for.
- *Why not render on the server:* nothing to gain, and it would add latency and a pipeline stage.

### 8. All-keys practice on recordings reuses the player's transposition

Twelve keys map onto the player's range as offsets from minus 5 to plus 6 semitones from the song's own key. At each loop wrap the drill sets the next offset with `setGlobalPitch`, and restores the starting value when it stops or the view closes.

- The pitch stage has latency, so a key change exactly on the wrap can smear the first beat. The drill therefore inserts a one-bar gap with a click between passes by default (the count-in machinery), which also gives the player a bar to think. The gap can be turned off.
- Shifts of five or six semitones sound thin. This is accepted for practice and stated in the drill's help text.

### 9. Phrases store references, not audio

A phrase is a time range on a stem plus the harmony under it at the moment of saving. Notes are read from the existing transcription when the phrase is opened and converted to scale degrees against the resting key in the browser. Nothing is copied or rendered.

- *Consequence:* re-transcribing a stem updates every phrase on it, and deleting the song removes its phrases with the folder.

### 10. Naming and source material

- The feature is called Roadmap, and the vocabulary is bricks and joins. The word "LEGO" appears only in the credit line that names the first book.
- No sentence, table, chart, roadmap or recording from either book is included. Descriptions are written fresh. No song charts ship with StemDeck.
- Test fixtures use chord progressions typed for the tests. Chord progressions are not protected, but the fixtures do not reuse either book's printed layouts or analysis tables; expected analyses in tests are worked out by applying the rules in section 5.
- The two PDFs and any text extracted from them stay out of the repository. The `.gitignore` gains a pattern for them as a guard.
- A credit line naming both books and authors appears in the catalogue, on the printed roadmap, and in `docs/harmony.md`.

## Risks / Trade-offs

- [Typing a chart is a barrier, so few songs get one] → A forgiving paste format, a clear empty state, generated drills that need no chart at all, and chord recognition named as the follow-up.
- [The analysis disagrees with how the user hears the song] → Corrections stored with the song, unnamed stretches instead of forced labels, and the cost weights kept in one place so they can be tuned against a growing set of fixtures.
- [Real recordings do not repeat the form cleanly: intros, tags, double time, rubato] → Chorus starts are placed by hand and each can be moved; anything outside a chorus is simply not highlighted. A different chart per chorus is out of scope.
- [The bar grid is wrong on swing recordings, which misplaces every bar] → The grid is already user-editable, placements keep their times when it changes, and the roadmap says so when there is no grid.
- [Pitch-shifted audio sounds poor far from the original key] → Stated in the drill; the generated backing is the clean alternative.
- [The synthesised backing sounds plain] → Accepted; it is a reference, and per-part levels let the player use only the bass.
- [The change is large] → Three slices in task order, each ending in a working feature behind the Labs badge. Slices two and three can be cut to follow-up changes without rework.
- [Brick and join names are another author's vocabulary] → Credit in the app and docs, ids separate from names so they can be replaced, and the open question below.
- [About 30 new prose strings and many labels in ten languages] → No prose per brick; names untranslated; the existing i18n test catches gaps.
- [A brick id is renamed or removed later, orphaning corrections, phrases and progress] → Ids are never reused; removed ids stay in an alias table that maps them to a replacement or to "unfiled".

## Migration Plan

The change is additive. A song with no `harmony/` folder has no chart and behaves as today. There is no data to migrate.

- **Rollout:** ship behind the Labs badge after each slice.
- **Rollback:** remove the rail button and the `harmony:begin`/`harmony:end` lines, the `static/js/harmony/` folder and the endpoints. Leftover `harmony/` folders and `harmony_progress.json` are ignored by everything else and can be deleted or kept.

## Open Questions

- **Ask the publisher before a public release?** Both books are published by John Elliott (dropback.co.uk). A short note describing the feature and the credit line would be courteous and removes the naming risk. It does not change what is built: if the answer were no, the display names change and the ids stay.
- **Should Roadmap leave Labs?** Decide after the first slice has been used on real songs.
- **Which import comes first after this change:** iReal Pro charts, or chord recognition from the stems?
