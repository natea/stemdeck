# Design

## Context

See proposal.md for motivation. This change sits on top of `add-stem-transcription`, which provides: as-played notes per stem in `stems/transcription/<stem>.json`, a pure quantiser (`quantize(notes, grid, parts_per_beat)` giving each note a bar, beat, part and length in grid steps), the merged beat grid helper, and MIDI and MusicXML writers.

What shapes the approach:

- **The frontend has no build step and no runtime dependencies.** `static/js` is plain ES modules; third-party code is vendored as files under `static/vendor/` (multitrack.js, signalsmith-stretch.js, soundtouch-processor.js).
- **Content-Security-Policy** (`app/main.py`): `default-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`, `style-src 'self' 'unsafe-inline'`, `font-src 'self' data:`. There is no `worker-src`, so workers fall under `default-src 'self'`: a worker loaded from a file the app serves is allowed, a `blob:` worker is not.
- **StemDeck's player is the clock.** Stems play through its own engine with time-stretch, pitch shift, loop and per-stem mixing. Anything that shows position must follow it, not run beside it.
- **alphaTab 1.9.0** (MPL-2.0, no dependencies) ships ES-module builds (`alphaTab.min.mjs`, `alphaTab.core.min.mjs`, a worker module), the Bravura font (SIL OFL 1.1) and a soundfont. It reads alphaTex, MusicXML and Guitar Pro files, renders staff and tab, exports Guitar Pro 7, and since 1.6 has an external-media player mode in which the host supplies the playback position and per-bar sync points map bars to media time.

## Goals / Non-Goals

**Goals:**
- A score that is always derived from stored notes, the current beat grid and the current tuning. Nothing notation-specific is cached on disk except the user's choices.
- One clock. The cursor is a view of the player's position.
- Fingering decided on the server in one tested place, so the view and every export show the same frets.
- alphaTab stays behind one module, so an upgrade or a swap touches one file.

**Non-Goals:**
- Using alphaTab's synthesiser, soundfont or audio worklet.
- Notation-quality engraving choices beyond what alphaTab does by default.
- Techniques (bends, slides, hammer-ons, palm mutes). The transcription holds pitches and times only.
- A notation view in the mobile UI.

## Decisions

### 1. Vendoring alphaTab

`static/vendor/alphatab/` holds, from the npm tarball `@coderline/alphatab@1.9.0`: `alphaTab.min.mjs`, `alphaTab.core.min.mjs`, `alphaTab.worker.min.mjs`, `font/Bravura.woff2`, `LICENSE` (MPL-2.0) and `font/Bravura-OFL.txt`, plus a `VERSION` file with the version and each file's SHA-256. The soundfont, the worklet, the UMD build and the other font formats are left out (about 1.6 MB kept of 14 MB).

- Files are unmodified, which keeps the MPL-2.0 obligation to a notice and the license file. MPL-2.0 is compatible with AGPL-3.0.
- alphaTab is imported lazily (`await import(...)`) when the view first opens, so it adds nothing to startup.
- `settings.core.fontDirectory` and `settings.core.scriptFile` point at the vendored paths, so alphaTab starts its worker from a same-origin file. If the worker cannot start, `core.useWorkers = false` renders on the main thread.

Alternative considered: loading from a CDN. Rejected: the app works offline and the CSP forbids it.

### 2. The score format between server and view: alphaTex

A new endpoint returns the score as alphaTex text, generated in Python from the quantised notes:

`GET /api/jobs/{id}/transcription.alphatex?stems=&parts=4`

alphaTex expresses everything this change needs: tracks, staff and tab staves per track, tuning and capo, time-signature and tempo changes, notes as pitch or as fret and string, percussion, and `\sync` points that pin a bar to a media time.

- **Why server-side text and not building alphaTab's model in JavaScript:** the generator is a pure function next to the quantiser and the fingering, and is unit-tested with pytest. The browser side stays a thin `api.tex(text)` call.
- **Why not feed alphaTab the MusicXML export:** MusicXML cannot carry the sync points, and alphaTab's MusicXML import is one more translation between the fingering and what is drawn.
- **Durations.** A quantised note's length in grid steps is split into tied note values within each bar (for example five sixteenths is a quarter tied to a sixteenth), and gaps become rests. This is the same decomposition the MusicXML writer needs, so it moves into a shared helper.
- **Voices.** A monophonic stem is one voice. A polyphonic stem groups notes that start together and share a length into chords; notes that overlap with different lengths are trimmed to the next onset in that track. This loses some sustain in piano parts and is stated in the view.
- **Octave.** Guitar and bass are written an octave above where they sound. The track is given alphaTab's display transposition so the staff reads conventionally while the pitches stay true.

### 3. Following the player

alphaTab runs in external-media mode. A small bridge module implements alphaTab's external media handler against StemDeck's player: it reports duration, playback rate and volume, forwards alphaTab's seek requests to the player (this is how a click on a bar moves the song), and while the song plays pushes the player's current position to alphaTab on each animation frame.

- **Sync points come from the beat grid:** one per bar, at the time of that bar's first beat from the merged grid. alphaTab interpolates inside a bar. Tempo drift is therefore followed bar by bar, with no separate tempo estimate.
- **Speed and loop need nothing special:** the bridge only ever reports where the player is, so half speed and loop jumps are just positions.
- **Silence:** player mode is external media, so alphaTab never creates an audio context or loads the soundfont.

Alternative considered: alphaTab's own player with StemDeck's audio as a backing track. Rejected: it would be a second transport fighting the first, and it cannot time-stretch or mix stems.

### 4. Fingering

New module `app/pipeline/fingering.py`, pure and model-free: `assign(qnotes, tuning, capo) -> (placed, unplaced)`.

1. **Candidates.** For each note, every (string, fret) with `open + capo + fret == pitch` and fret from 0 to 20.
2. **Events.** Notes with the same quantised start form one event. For an event, enumerate combinations with distinct strings whose fretted notes span at most four frets; open strings do not count toward the span.
3. **Path.** Dynamic programming over events picks the sequence with the lowest total cost. Cost per event: hand position (mean fretted fret, so low positions win ties), plus distance moved from the previous event's position, plus a small charge for skipping strings. A rest longer than a bar resets the movement term, since the hand can relocate.
4. **Unplaceable.** A note with no candidate is set aside. An event with no valid combination drops its highest-cost notes until one exists. Both are returned as `unplaced` with a reason (`out_of_range`, `too_many_notes`).
5. **Suggestion.** If more than 5% of notes are out of range, score each preset tuning by notes placed and return the best as a suggestion.

The beam is capped (for example the 24 best combinations per event) so a dense guitar part stays fast.

Alternative considered: letting alphaTab or the notation program choose frets. Rejected: the view, the Guitar Pro file and the MusicXML would disagree, and none of them optimises across a phrase.

### 5. Tunings

Presets in `app/core/config.py` as open-string MIDI pitches, low to high: guitar standard (40 45 50 55 59 64), drop D, half-step down, D standard, open G, DADGAD, seven-string; bass standard (28 33 38 43), drop D, five-string (23 28 33 38 43), half-step down. A custom tuning is a list of four to eight pitches.

The choice is stored per song in `stems/transcription/tab.json`: `{"guitar": {"preset": "drop_d", "tuning": [...], "capo": 0, "display": "both"}, "bass": {...}}`, read and written through `GET`/`PATCH /api/jobs/{id}/transcription/tab`. It lives with the transcription, travels with the song, and never touches the notes.

### 6. View choices that are not about tab

Which stems are shown, zoom, layout and resolution are per-song UI state, kept the way the song's other per-mode view state is kept in the browser. Only tuning, capo and staff/tab/both go to the server, because exports depend on them.

### 7. Exports

- **Guitar Pro** is produced in the browser by alphaTab's Guitar Pro 7 exporter from the score it has loaded for the chosen stems, then saved under the song's name. No Python writer and no new dependency, and the file is by construction what the view shows. The `GET .../transcription.alphatex` endpoint is the source, so a client without the view can still get it by loading the text into alphaTab.
- **MusicXML** gains, for fretted parts, a `<technical>` string and fret on each placed note and the part's staff tuning and capo. If music21 cannot express the staff tuning, the writer adds those elements to the tree before serialising.
- **MIDI** is unchanged.

The spec's "refuses with a reason that names the missing beat grid" for Guitar Pro is met by the alphaTex endpoint's refusal, which the view shows.

### 8. Where the view lives

A **Notation** toggle in the studio, beside the existing view controls, in Practice and Advanced modes. It opens a resizable panel below the stem lanes, so the waveform, loop and transport stay in reach. Karaoke and Performance own the whole window and do not get it.

Alternative considered: a fifth mode. Rejected for now: modes keep their own stems and saved mix, and reading the score should not change what is heard.

## Risks / Trade-offs

- **[alphaTex and the external-media API changed across recent alphaTab releases (a new alphaTex parser in 1.7, external media in 1.6)]** → Pin 1.9.0, record file hashes, start with a spike that loads a hand-written alphaTex file with sync points and drives the cursor from a fake clock, and cover the generator with a Playwright test that loads its output into the real vendored alphaTab and asserts zero parse errors.
- **[A dense score is slow to lay out]** → Render in the worker, use alphaTab's lazy rendering, default to the stems the user can read at once (not all eight), and show bars as they arrive.
- **[Wrong notes look authoritative once engraved]** → The view carries a short "transcribed automatically" note with the beat grid's confidence, and links to the beat-grid editor.
- **[Fingering is a heuristic and will sometimes pick a position no player would]** → Tuning, capo and the low-position preference are adjustable; hand-editing is out of scope and the Guitar Pro export is the route for fixing by hand.
- **[Polyphonic stems lose overlapping sustain in one voice]** → Stated in the view; the MIDI export keeps true lengths.
- **[The desktop webview may treat module workers differently from Chrome]** → The main-thread fallback covers it, and the desktop Playwright suite gets one notation test.
- **[1.6 MB more in every install]** → Loaded only when the view opens.

## Migration Plan

Additive, after `add-stem-transcription` ships. A song with no `tab.json` uses default tunings. Rollback is removing the toggle, the endpoints and the vendor folder; leftover `tab.json` files are inert. Archive this change after `add-stem-transcription`, because its `notation-export` delta adds to a spec that change creates.

## Open Questions

- Whether `other` should be offered as tab when it is mostly a second guitar. Left out; it can be added as a per-stem option without changing the design.
