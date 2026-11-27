# Chords (Labs)

<sub>[Back to the README](../README.md)</sub>

The Chords strip shows a song's chords along its timeline, under the Markers bar. StemDeck detects them from the audio when you ask, lights the chord that is sounding as the song plays, and lets you correct what it got wrong.

It is marked **Labs** because the result is a draft. Expect mistakes, most of all in jazz.

## Using it

1. Open a song and press **Chords** in the sidebar rail (the keyboard icon marked Labs). The strip appears under Markers. It stays off until you turn it on, and remembers your choice.
2. Press **Detect**. StemDeck listens to the whole song on this computer. It takes under a minute and the song never leaves your computer. The first time, it downloads the chord model (29 MB); after that it works offline. The line under the strip says which step it is in, and **Cancel** stops it.
3. Play the song. The chord under the playhead is lit. Click a chord to play from where it starts.

Every chord whose symbol there is room for shows it, squeezed a little sideways when that is what makes it fit. With the whole song on screen there is not room for all of them: a symbol is then shown whole or not at all, never cut off, and the chord that is sounding always shows its own. Zoom the waveform in to see more of them, or point at a chord to read it.

| Control | What it does |
|---|---|
| **C/E** | Shows the bass note of each chord, as a slash chord. Off by default: over a walking bass the bass note changes on almost every bar while the chord does not, and with it off that chord is shown once. |
| **Pencil** | Turns correcting on. Then a click on a chord opens a small editor. |
| **Arrow** | Appears once you have corrected something. Discards every correction and shows the detected chords again. It asks first: press it twice. |
| **Detect** | Detects the chords, or detects them again. Your corrections are kept either way. |

The chords are written for the key you are hearing. Transpose the song with Global Key and they move with it: `C F G7` becomes `D G A7` two semitones up. Sharps or flats are chosen from the song's key, so the chord between G and A reads `G#m` in E major and `Ab` in F minor.

## Correcting a chord

With the pencil on, click a chord (or an empty stretch) to open the editor.

- **Type another chord** and press Enter. The usual spellings are read: `Cm7`, `C-7`, `Cmin7`, `Cmaj7`, `CM7`, `CΔ`, `Cø`, `C°7`, `C+`, `C7b9`, `C7(b9)`, `C6/9`, `Csus`, `C/E`. A symbol that cannot be read is refused and nothing changes.
- **Start earlier** and **Start later** move where the chord begins by one beat. The chord before it ends there. Without a beat grid they move by half a second.
- **No chord** empties the stretch.
- **Delete** removes the chord. The chord before it then lasts until the next one.

Corrections are saved as you make them. They are kept apart from what the detector found, so pressing Detect again never discards them: your corrected chords stay on the strip, and the arrow button goes back to the detected ones.

## How good it is

The detector is [lv-chordia](https://github.com/openmirlab/lv-chordia), the large-vocabulary chord model of Jiang, Chen, Li and Xia (ISMIR 2019). It names triads, sevenths, sixths, ninths, elevenths and thirteenths, suspended chords, and dominant chords with an altered ninth, eleventh or thirteenth.

It was tried on three recordings before it was built in:

- **A soul song with a vamp and a clear chorus:** the vamp and the chorus chords were right and steady.
- **A four-chord pop loop:** three of the four chords, in a stable loop.
- **A jazz standard, five choruses of 32 bars:** the form was readable. Against the standard changes, measured every half bar, the root agreed 61% of the time and the root and chord type together 36%.

What it tends to get wrong in jazz: it drops the first chord of a ii-V (the minor seventh before the dominant), it calls the home chord a dominant seventh, and it loses its way in a free ending. Chord changes shorter than a beat are not shown.

## What it does to the times

The detector places a chord change where it hears one. The strip places it on the nearest beat of the song's beat grid, which is how a chart writes it. This is worked out each time the chords are read, from the stored detection and the song's current grid. So when you correct the beat grid, the chord changes move with it, with no new detection.

A song with no beat grid shows the detector's own times.

## For developers

```
app/pipeline/chords_worker.py   the worker process: mixes the song, runs the model, writes the file
app/pipeline/chords.py          starts the worker, reads its progress, handles cancel and stalls
app/pipeline/chord_labels.py    reads the model's labels into chords
app/pipeline/chord_snap.py      puts chord changes on beats
app/core/chord_model.py         what a stored chord is
app/core/chord_files.py         the two files per song
app/api/chords.py               the four routes
static/js/harmony/chords.js     writes and reads chord symbols, spells them for a key
static/js/chords/               the strip: chordStripCore.js (logic) and chordStrip.js (page)
```

**Stored per song**, in its `stems/` folder:

- `chords.json`: what the detector found, with its own times and labels. Replaced by each detection.
- `chords.user.json`: your corrected timeline. Never written by a detection.

A chord is stored as facts, not as text:

```json
{"start": 2.6, "end": 5.1, "root": 0, "degrees": ["1", "3", "5", "b7"], "bass": 4, "label": "C:7/3"}
```

`root` and `bass` are pitch classes (0 is C). `degrees` are the chord tones as scale degrees above the root. `"root": null` is "no chord". The symbol is written in the page, because it depends on the key, the transposition and whether bass notes are shown. `label` is the detector's own label, kept so nothing is lost.

**The audio it listens to** is the whole song: every stem on disk summed, with the Original lane when the song was imported as a subset of stems. Detection from single stems was tried and was worse (piano and bass alone gave "no chord" for two thirds of a song).

**Settings** are in [Configuration](configuration.md): `STEMDECK_CHORDS_VOCABULARY` and `STEMDECK_TIMEOUT_CHORDS`. The routes are in the [HTTP API](api.md), and the model's license in [Model licenses](models.md).

**Tests:** `tests/test_chord_*.py` and `tests/test_chords_*.py` for the backend, `tests/js/chords.test.mjs` and `tests/js/chord-strip.test.mjs` for the page's logic, `tests/e2e/chords.spec.mjs` in a browser. The model itself runs only when asked:

```sh
STEMDECK_TEST_REAL_MODELS=1 uv run pytest tests/test_chords_real_model.py -q
```
