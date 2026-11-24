# Tasks

Groups 1 to 6 are slice one (the map), groups 7 to 9 are slice two (the drills), group 10 is slice three (phrase collections). Each slice ends in a feature that works on its own behind the Labs badge.

## 1. Guard rails and scaffolding

- [ ] 1.1 Add `.gitignore` patterns for the two source PDFs and any text extracted from them (`lego_*.pdf`, `insights_*.pdf`, `*.book.txt`); verify `git check-ignore -v lego_test.pdf insights_test.pdf` reports both as ignored and `git status` shows no book file
- [ ] 1.2 Create `static/js/harmony/` with an `index.js` that exports `initHarmony()` and wire it in `static/js/main.js` between `// harmony:begin` and `// harmony:end` markers; verify the app loads with no console error and `grep -c "harmony:begin" static/js/main.js` matches the count of `harmony:end`
- [ ] 1.3 Confirm the licence of Impro-Visor and whether its published roadmap description is usable as a reference, and record the finding in `design.md` under decision 5; verify the note states the licence version and a yes or no on reuse

## 2. Chords and chart text

- [ ] 2.1 Implement `harmony/chords.js` (read a symbol into root, type class, bass and the typed text; spell a chord in any key and for concert, B flat and E flat instruments, choosing sharps or flats by key); verify `tests/js/harmony-chords.test.mjs` covers every spelling listed in the `chord-charts` spec, slash chords, enharmonic choice in all twelve keys, and a rejected symbol
- [ ] 2.2 Implement `harmony/chartText.js` (text to chart and back: `|` bars, `%` repeats, `[A]` sections, several chords per bar, per-chord beats); verify node tests cover the three text scenarios in the spec, a round trip that returns the same text, and an error that names the bar and the unreadable text
- [ ] 2.3 Implement `harmony/chart.js` (chart model, chorus placement along a bar grid, moving one chorus start, marking the end, and "what is sounding at time t"); verify node tests cover the 32-bar placement at bar 9 of 136, a late third chorus, a time in the intro, and a song with no bar grid

## 3. Chart storage and API

- [ ] 3.1 Add `app/core/harmony_files.py` to read, validate and write `harmony/chart.json` atomically, following `app/core/beat_files.py`; verify `tests/test_harmony_files.py` covers a round trip, a rejected malformed chart, and a missing file read as "no chart"
- [ ] 3.2 Add `GET/PUT/DELETE /api/jobs/{id}/chords` and `GET /api/harmony/charts`; verify `tests/test_harmony_api.py` covers save and reload, delete, refusal for an unfinished or failed song, and the library read returning only songs that have charts with their titles
- [ ] 3.3 Keep chorus starts at the same moment when the bar grid changes: on load, snap each stored start to the bar nearest its stored time; verify a test that shifts the first downbeat of a song with a placed chart and finds every chorus start at the same time within half a bar
- [ ] 3.4 Document the chart file and the four endpoints in `docs/api.md`; verify each documented request runs as written against a seeded song

## 4. Brick catalogue

- [ ] 4.1 Implement `harmony/catalogue.js` with the join table and the brick entries (cadences, turnarounds, dropbacks, larger blocks, other), each with a stable id, family, formula relative to its resting root, usual rhythm and name; verify a node test checks unique ids, that every formula spells to valid chords in all twelve keys, that every larger block refers to existing brick ids, and that the families required by the `harmony-bricks` spec are present
- [ ] 4.2 Add spelling of a brick in any key and its minor form; verify node tests for the plain cadence in E flat, the minor form in C, and the join table against the twelve names in the spec in both C and A flat
- [ ] 4.3 Add strings in all ten languages for the five families, the twelve joins and the concept terms, and the credit line naming both books; verify the existing i18n completeness test passes and a node test checks that every brick and join name is identical in all ten languages

## 5. Analysis

- [ ] 5.1 Implement normalisation and candidate matching in `harmony/analyse.js` (type classes, merged repeats, optional chords, minor form, half, normal and double harmonic rhythm); verify node tests match a plain cadence at one and two chords to the bar and reject a near miss
- [ ] 5.2 Implement the best-cover search with fixed corrections, the cost weights in one exported table, deterministic tie-breaking, and unnamed stretches; verify node tests for the three analysis scenarios in the spec (the cadence song, the four-cadence bridge, the join across the repeat), the unknown-stretch scenario, and that analysing the same chart twice gives identical output
- [ ] 5.3 Implement hovers, joins and home or away; verify node tests for the four-bar major then minor hover, the two-bar resting chord that is not a hover, a cadence marked away from home, and no join named after a turnaround
- [ ] 5.4 Implement larger blocks that can be opened into their bricks; verify node tests for the rhythm bridge and a Pennies ending
- [ ] 5.5 Add a transposition property test: every fixture chart analysed in all twelve keys and with alternate chord spellings gives the same bricks and joins; verify it passes for at least ten fixture charts typed for the tests
- [ ] 5.6 Write `tests/js/fixtures/harmony/README.md` stating that fixtures are typed for the tests, hold chords only, and that expected analyses are derived from the rules in `design.md`; verify the file exists and each fixture has an expected-analysis file beside it

## 6. Roadmap view

- [ ] 6.1 Add the Roadmap rail button with a Labs badge in `static/index.html`, the overlay shell, `static/css/harmony.css`, a Guide entry in `helpMode.js`, and strings in ten languages; verify a Playwright spec opens and closes it during playback with no gap in audio time, no change to any stem's mute, solo or volume, and that it is hidden while Karaoke or Performance is open
- [ ] 6.2 Implement the chart editor in the overlay (paste or type text, live parse errors, save, remove, set the first chorus bar, move a chorus start, mark the end); verify a Playwright spec pastes a chart, sees the error for a bad chord, saves, reloads and finds the chart and placement intact
- [ ] 6.3 Implement `harmony/roadmap.js` and `roadmapView.js` (eight bars per row, new row per section, rows of eight then the remainder, brick names over chords, joins at brick starts, markers for minor form, tension and away from home that do not rely on colour); verify node tests for the view model with 32-bar and 12-bar sections and a Playwright spec that checks the AABA layout and that each marker has a text or shape cue
- [ ] 6.4 Follow the recording: highlight bar, brick and section, show the chorus number, and show nothing outside a chorus; verify a Playwright spec plays into the second chorus, seeks, and seeks into the intro, checking the highlight each time
- [ ] 6.5 Add display key (as heard, any of twelve, concert, B flat, E flat) and the names-only mode; verify a Playwright spec transposes the song up two semitones and sees chords move while brick names stay, and that B flat writes chords a whole tone higher without changing the sound
- [ ] 6.6 Add looping a bar, brick or section from the roadmap, with "next chorus each time"; verify a Playwright spec loops a four-bar brick in the second chorus and checks the loop range, then checks the range moves a chorus on the next pass
- [ ] 6.7 Add corrections (rename to a catalogue entry or a custom name, move a brick's start or end, set a section's home, remove a label, clear all, "needs review" after the chords under a correction change); verify node tests for corrections surviving re-analysis and a Playwright spec that renames a brick and finds it after reload
- [ ] 6.8 Add "other songs with this brick or join" from the library charts, opening the chosen song at that bar; verify a Playwright spec with three seeded charts lists the two that share a join and opens one at the right bar, and shows the empty message when none match
- [ ] 6.9 Add the print stylesheet (one landscape page for a 32-bar chorus with title, key and credit line); verify a Playwright spec renders the print layout to PDF and finds one page
- [ ] 6.10 Add the new specs to `tests/e2e/spec-map.json` and extend `tests/e2e/seed.py` with a song that has a chart and one that does not; verify the mapped specs run with the parallel runner on a non-default port
- [ ] 6.11 Write `docs/harmony.md` (what a chart is, the text format, placing choruses, reading the roadmap, correcting it, credits) and link it from the README; verify every text example in the doc parses with `chartText.js` in a node test

## 7. Generated backing

- [ ] 7.1 Implement `harmony/backing.js` (look-ahead scheduler on the shared audio context; bass, shell chords and the existing click presets; separate gain per part; tempo; count-in; stop that releases every node); verify node tests with a fake audio context check the scheduled notes for a plain cadence in F at 100 beats per minute and that stop leaves no scheduled events
- [ ] 7.2 Pause the song when a backing starts and leave position, loop, speed, transposition and mix untouched; verify a Playwright spec starts a drill during playback and compares the transport and mixer state before and after
- [ ] 7.3 Add "hear this brick" to the catalogue and to any brick on a roadmap, in any key; verify a Playwright spec plays the plain turnaround in A flat and sees four chord events and then silence

## 8. Drills

- [ ] 8.1 Add the Drills panel in the overlay with the one-brick-one-key drill (brick, key, major or minor form, tempo, twelve passes or repeat, levels for bass, chords and click, and the three display modes); verify a Playwright spec runs twelve passes at a fast test tempo, silences the chord part, and switches to key-name-only display
- [ ] 8.2 Add the join-through-the-keys drill, computing the keys a join reaches and the further sequences needed to cover all twelve; verify node tests give twelve keys for the four joins that reach every key, six, four, three, two and one for the others, and that the offered sequences together cover all twelve keys with no key twice
- [ ] 8.3 Add all-keys practice on a recording (cycle or half-step order, optional one-bar gap with click between passes, restore the starting transposition on stop or close, unavailable when transposition is unavailable); verify a Playwright spec runs twelve passes on a seeded song, records twelve distinct offsets within minus 5 to plus 6, and finds the original transposition restored after stopping at pass five
- [ ] 8.4 Add "real examples of one brick" across the library with a pass count per example and the fallback to the generated drill; verify a Playwright spec with three seeded charts plays the three stretches in turn and shows the fallback for a brick no chart contains
- [ ] 8.5 Add the "where am I?" drill for the open song and for all songs with placed charts (random moment inside a chorus, roadmap and position hidden, answer by section, reveal with time taken); verify a Playwright spec with a seeded random source answers once correctly and once wrongly and checks both reveals
- [ ] 8.6 Add the ear quiz for joins and bricks over a user-chosen set, and the timed cycle and scale-degree quiz with weak keys in the result; verify node tests for question generation and marking (including "V of D flat" and a Cherokee from G) and a Playwright spec that completes a five-question round of each
- [ ] 8.7 Add the drills section to `docs/harmony.md` and Guide entries for each drill; verify the i18n completeness test passes

## 9. Progress and learning path

- [ ] 9.1 Add `DATA_DIR/harmony_progress.json` with `GET/PATCH/DELETE /api/harmony/progress`; verify `tests/test_harmony_progress.py` covers recording a practice event, marking learned, reset, and a second client reading the same record
- [ ] 9.2 Implement `harmony/progress.js` (record drill and quiz results, mark learned, songs fully readable, the next brick or join that adds the most songs, and the built-in starter order for a small library); verify node tests for the dropback scenario in the spec, the empty library, and a tie broken by the starter order
- [ ] 9.3 Show the learning path in the Drills panel with "start a drill on this" and the list of readable songs; verify a Playwright spec marks a brick as learned, restarts the app, and still sees it learned and the suggestion updated
- [ ] 9.4 Document the progress endpoint in `docs/api.md`; verify the documented requests run as written

## 10. Phrase collections

- [ ] 10.1 Add `harmony/phrases.json` storage with `GET/POST /api/jobs/{id}/phrases`, `PATCH/DELETE /api/jobs/{id}/phrases/{phrase_id}` and `GET /api/harmony/phrases`; verify `tests/test_harmony_phrases.py` covers save, rename, re-file, delete, the library read, and that deleting a song removes its phrases from the library read
- [ ] 10.2 Add "save loop as phrase" on a chosen stem, capturing the brick, chords and key from the placed chart or filing as unfiled; verify a Playwright spec saves a two-bar phrase over a cadence and finds the brick and key stored, and saves one on a chartless song as unfiled
- [ ] 10.3 Add the collection view grouped by family and brick with major and minor groups, filters, rename, re-file and delete; verify a Playwright spec with five seeded phrases in three songs checks the grouping and a re-file that survives reload
- [ ] 10.4 Add the scale-degree view from the stem's transcription, marking notes outside the scale of the chord under them, with the offer to transcribe when there is none; verify node tests for the D, F, A, B, G example and for an outside note, and a Playwright spec for the untranscribed case
- [ ] 10.5 Add phrase practice (open the song at the phrase, loop, chosen speed, optional mute of the phrase's stem restored afterwards) and all-keys practice with passes per key and hold; verify a Playwright spec checks the loop, the 70 percent speed, the mute and its restore, and twelve keys at two passes each
- [ ] 10.6 Add the workout (chosen phrases, passes each, total length shown first, moves between songs, skips an unloadable song with a notice); verify a Playwright spec runs a three-phrase workout across two songs and one with a missing song
- [ ] 10.7 Add the phrase endpoints to `docs/api.md` and a phrases section to `docs/harmony.md`; verify the documented requests run as written

## 11. Integration checks

- [ ] 11.1 Run the full backend, node and mapped e2e suites with the parallel runner on a non-default port; verify all pass and that `tests/test_network_gate.py` and `tests/test_csp.py` are unchanged and green
- [ ] 11.2 Walk the whole flow on a real jazz recording in the desktop shell with a scratch data folder: type a chart, place choruses, correct one label, loop a brick, run each drill, save and practise a phrase; verify by recording the outcome of each step in the change's review notes
- [ ] 11.3 Search the repository for book content and the trademark: verify `git grep -i "lego"` finds only the credit line strings and docs credit, and that no fixture or doc reproduces a table or roadmap from either book
- [ ] 11.4 Run `openspec validate add-jazz-harmony-bricks --strict`; verify it passes
