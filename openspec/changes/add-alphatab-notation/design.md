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
  As built: `app/pipeline/note_values.py` holds `split_steps` and the grouping of notes into written events (`chord_spans`, `voice_spans`, `drum_spans`). The grouping moved there out of the MusicXML writer, which now imports it. The split itself had nothing to move: the MusicXML writer of `add-stem-transcription` leaves ties and rests to music21, and still does, so `split_steps` is new code used by the alphaTex writer. The two writers can therefore differ in how they break one long note into tied values, never in which notes start where.
- **Unplaced notes.** A fretted stem shown as both is one `score tabs` staff when every note has a string and fret. When some do not, it is two staves in the track, a staff with every note and a tab staff with the placed ones, because alphaTab cannot hide a note from the tab half of one staff.
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
  As built: the file is made from the same endpoint's text asked for with `unplaced=omit`, not from the score object on screen. The two are the same text unless a fretted stem has notes with no string and fret. The view then draws two staves for that stem (notation with every note, tab with the placed ones), and a Guitar Pro track made of those two staves was read by MuseScore 4 with the wrong tuning. For the file the stem stays one staff and those notes are left out; the view has already counted them.
  Saving it (decided during the build; it was an open question): the view posts the file's bytes to `POST /api/jobs/{id}/transcription.gp` and then downloads them from the `GET` of the same path, through the same download helper as every other export. The reason is the desktop app: its shell saves a download only by fetching a localhost URL itself (`pick_export_destination`, then `download_to_path`) and deliberately has no command that takes bytes from the page, so a file that exists only in the page could be saved by a browser and not by the desktop app. The endpoint holds one file per song under the cache folder for ten minutes, accepts only a Guitar Pro 7 file (a zip holding `Content/score.gpif`) of at most 4 MB, and writes nothing into the song's folder. The shell is unchanged. Alternatives rejected: a new shell command that takes bytes (a wider surface in the shell, and three platforms to rebuild and test), and offering the file in the browser only.
- **MusicXML** gains, for fretted parts, a real tab staff under the notation. music21 writes the score as before and cannot write a tab staff, so a pass over the finished document turns each fretted part into two staves: staff 1 is music21's notation, untouched, with every note; staff 2 has a `TAB` clef, `<staff-details>` with the lines, the tuning of each string and the capo, and one voice built from the notes with the rhythm the view draws, a `<technical>` string and fret on each placed note and rests where nothing placed sounds.
  Decided during the build (it was an open question): the first form, a string and fret on the notes of the ordinary staff, is valid MusicXML and music21 reads it back, but MuseScore 4 ignores `<fret>` and the tuning on a staff that is not a tab staff and prints each `<string>` as a circled number over the note. A first attempt at the tab staff copied music21's voices onto staff 2, which gave voice numbers up to 9 and a file MuseScore refused; the tab staff is therefore written as a single voice. Checked on a real song (126 bars, 2,261 guitar notes): MuseScore 4 opens the file with two tablature staves and the frets the view shows. The same pass renumbers the voices of a bar from 1, because music21 counts them from 0 and MuseScore drops a part that has a voice 0.
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

## Spike Findings (task 1.3)

A throwaway page, served by the app with its real headers, loaded a hand-written two-track alphaTex score (a staff, a staff with tab, five `\sync` points) into the vendored alphaTab 1.9.0 and drove the cursor from a fake clock. It was run in Playwright Chromium, in Playwright WebKit, and in the macOS system WKWebView loaded from `http://127.0.0.1:<port>` (the engine and origin the macOS desktop shell uses), each with the worker on and with `useWorkers = false`. All six runs: the score rendered, the CSP was unchanged, there were no console errors or CSP violations, every request was same-origin, and no `AudioContext` was created. The packaged desktop app itself was not launched; that is task 7.1.

The alphaTab names the bridge uses, as they are in 1.9.0:

- **Loading:** `await import("/vendor/alphatab/alphaTab.min.mjs")`. It imports `alphaTab.core.min.mjs` itself and starts `new Worker(new URL("./alphaTab.worker.min.mjs", import.meta.url), {type: "module"})`, a same-origin module worker. Its blob-worker fallbacks are blocked by the CSP, which is why the main-thread fallback exists.
- **Settings:** `new alphaTab.Settings()`, then `core.fontDirectory`, `core.scriptFile`, `core.useWorkers`, `core.engine = "svg"`, and `core.smuflFontSources = new Map([[alphaTab.FontFileFormat.Woff2, ".../font/Bravura.woff2"]])`. Naming the one font file matters: the default source list also names the `.eot`, `.woff`, `.otf` and `.svg` files, which are not vendored.
- **Player:** `player.playerMode = alphaTab.PlayerMode.EnabledExternalMedia`, `player.enableCursor`, `player.enableUserInteraction`, `player.scrollElement`.
- **API:** `new alphaTab.AlphaTabApi(element, settings)`, `api.tex(text)`, `api.renderTracks(tracks)`, `api.play()`, `api.pause()`, `api.destroy()`, `api.boundsLookup.findMasterBarByIndex(i)`. Events (each has `.on(fn)`): `api.error`, `api.scoreLoaded`, `api.renderFinished`, `api.playerReady`, `api.playedBeatChanged`, `api.playerPositionChanged`.
- **External media:** `api.player.output.handler = { backingTrackDuration, playbackRate, masterVolume, seekTo(ms), play(), pause() }` and `api.player.output.updatePosition(ms)`. Times are milliseconds of media time.
- **Exporter:** `new alphaTab.exporter.Gp7Exporter().export(score, settings)` returns the file's bytes.
- **alphaTex:** `\track "Name" "short"`, `\staff{score}` / `\staff{tabs}` / `\staff{score tabs}`, `\tuning (G2 D2 A1 E1)` (highest string first), `\ts 4 4`, `\tempo 120`, and after the last bar a line holding `.` followed by `\sync barIndex occurence milliseconds [ratio]` lines.

What the spike showed about behaviour:

- `updatePosition(ms)` moves the cursor whether or not alphaTab has been told it is playing. `playedBeatChanged` fires only between `api.play()` and `api.pause()`. `api.play()` and `api.pause()` call the handler's `play()` and `pause()`, so the bridge's handler must not start or stop the player from them, or the two would call each other.
- With the handler's `playbackRate` fixed at 1, the position is plain media time: the cursor crossed each bar line at that bar's sync time (bar 2 at 2000 ms, bar 3 at 5000 ms, bar 4 at 7000 ms) and jumped back when the clock did. Speed changes and loop jumps therefore need no handling.
- A click on a bar calls `handler.seekTo(ms)` with the media time of that bar from the sync points (bar 3 gave 5000). alphaTab also calls `seekTo` once when a score loads, with a time near zero, which the bridge must not forward as a seek.
- The cursor does not move while the page is hidden (`document.visibilityState === "hidden"`). This is harmless here: a hidden page shows no cursor.

## Migration Plan

Additive, after `add-stem-transcription` ships. A song with no `tab.json` uses default tunings. Rollback is removing the toggle, the endpoints and the vendor folder; leftover `tab.json` files are inert. Archive this change after `add-stem-transcription`, because its `notation-export` delta adds to a spec that change creates.

## Open Questions

- Whether `other` should be offered as tab when it is mostly a second guitar. Left out; it can be added as a per-stem option without changing the design.
