# Design

## Context

See proposal.md for motivation. What shapes the approach:

- **Stems on disk.** A finished job has `stems/<name>.wav` or `.mp3` (`app/core/stem_files.py`; a song can be stored as MP3). Names are `vocals`, `drums`, `bass`, `guitar`, `piano`, `other`, plus `lead_vocals` and `backing_vocals` after a vocal split.
- **Beat grid.** `app/pipeline/beatgrid.py` writes `stems/beats.json`: `beats` (times in seconds, whole track, extended to the edges), `bars` (marks over beat indices, emitted only where the bar length changes; empty on the librosa fallback), `bpm`, `duration`. User edits live in `stems/beats.user.json` (`beats`, `beats_per_bar`) and `GET /api/jobs/{id}/beats` merges the two. A missing grid is already a supported state.
- **On-demand model work has a pattern.** The lead and backing vocal split (`vocal_split.py`, `vocal_split_worker.py`, `POST /api/jobs/{id}/vocal-split`) runs a non-persistent worker process under `_pipeline_lock`, speaks the `@@DONE@@` / `@@ERROR@@{json}` protocol on stderr, records a reason code, survives restarts as "interrupted", and refuses to overlap a stem fill.
- **Model downloads.** `app/core/model_cache.py` `load_or_heal` re-fetches a checkpoint that downloaded incompletely. Models are never bundled in installers.
- **Licensing is checked per model** and written up in `docs/models.md`. madmom was rejected for CC BY-NC-SA weights.
- **torch is already shipped** (2.6, or 2.2 on Intel Macs). TensorFlow is not, and must not become a dependency.

## Goals / Non-Goals

**Goals:**
- One model family per stem type, chosen for accuracy, behind a routing table that is data, not code.
- Raw notes are the stored truth; quantised output is a pure function of raw notes and the current grid.
- No new always-on cost: nothing loads at startup, nothing runs during import.
- A failure in one model costs one stem, not the run or the song.

**Non-Goals:**
- A persistent transcription worker. This is occasional work on a finished song, like the vocal split.
- Notation-quality engraving (voice separation, beaming choices, enharmonic spelling beyond the key signature). The MusicXML is a correct starting point for a notation program.
- Tuplet detection per beat. One grid resolution per export.
- Transcribing the full mix. Stems only.

## Decisions

### 1. Routing table

| Stem | Transcriber | Package | Output |
|---|---|---|---|
| `vocals`, `lead_vocals`, `bass` | CREPE + note segmentation | `torchcrepe` | monophonic notes |
| `piano` | ByteDance high-resolution piano transcription | `piano-transcription-inference` | polyphonic notes, velocities |
| `guitar`, `other`, `backing_vocals` | YourMT3+ | `mt3-infer` | polyphonic notes; instrument programs merged into one track |
| `drums` | YourMT3+ | `mt3-infer` | GM percussion notes |

Held in `app/core/config.py` as `TRANSCRIBE_ROUTES: dict[str, str]`, overridable per stem with `STEMDECK_TRANSCRIBE_<STEM>` (values `crepe`, `piano`, `mt3`). A model that fails its license review or proves weak on a stem can be re-routed without touching code.

- **`torchcrepe`, not `crepe`.** `crepe` on PyPI needs TensorFlow. `torchcrepe` is the same network and weights on the torch StemDeck already ships, MIT, and adds periodicity (a voicing confidence) and Viterbi decoding.
- **`mt3-infer` for YourMT3+.** The authors' repository is a research codebase, not an installable package. `mt3-infer` (openmirlab, MIT, on PyPI, needs torch >= 2.0) vendors the YourMT3 inference code and fetches the published checkpoints. It is from the same group as `all-in-one-infer`, which StemDeck already depends on. Alternative considered: the `yourmt3` PyPI package, rejected because it pins `transformers==4.45.1`, pulls in `lightning`, and loads weights from a third-party mirror.
- **`backing_vocals` goes to YourMT3+**, because harmonies are several voices at once and CREPE reports one pitch. YourMT3+ has a singing-voice class.
- **Drums go to YourMT3+** to avoid a fourth model. Alternative considered: ADTLib or Magenta's drum model; both would add TensorFlow.
- **Alternative considered: Basic Pitch for everything.** One small model, but its dependency set requires TensorFlow or CoreML per platform, and it is the least accurate option on every stem type.

### 2. Pitch curve to notes (CREPE path)

New module `app/pipeline/pitch_notes.py`, pure numpy, no model, fully unit-testable with synthetic curves.

1. Run torchcrepe (`full` model, 10 ms hop, Viterbi decoder) with `fmin`/`fmax` set per stem: 65 to 1100 Hz for vocals, 30 to 400 Hz for bass. Take `f0` and `periodicity`.
2. Voicing: a frame is voiced when periodicity is above a threshold, with hysteresis (enter at 0.5, leave at 0.35) and a stem-RMS floor so reverb tails after separation do not become notes.
3. Convert to fractional MIDI: `69 + 12 * log2(f0 / 440)`. Median-filter over 50 ms to remove single-frame octave jumps.
4. Segment: start a note at the first voiced frame. Keep a running median pitch for the note. End it and start a new one when the curve sits more than 0.6 semitone from that median for 40 ms or more. Vibrato (periodic, within about half a semitone) stays inside the band; a real step leaves it.
5. Split on re-attack: an onset peak in the stem's onset envelope (librosa, already a dependency) inside a voiced run splits a note even when the pitch does not change. This is what separates repeated notes, which pitch alone cannot.
6. Clean up: drop notes under 60 ms, merge same-pitch notes separated by under 40 ms with no onset between, round each note's median to the nearest semitone.
7. Velocity from the note's mean RMS, scaled to 1 to 127 against the stem's 95th percentile.

All thresholds are named constants in `config.py`, as `beatgrid.py` does. Alternative considered: an HMM note tracker (pYIN-style). More principled, but harder to tune and test; the rule-based version is the first cut and the module boundary lets it be replaced.

### 3. Stored format

`stems/transcription/<stem>.json`, written atomically (tmp then replace), one file per stem:

```json
{"version": 1, "stem": "bass", "transcriber": "crepe", "model": "torchcrepe-full",
 "duration": 214.3,
 "notes": [{"start": 12.431, "end": 12.902, "pitch": 40, "velocity": 96}]}
```

Times are seconds from the start of the song. A skipped silent stem gets a file with `"skipped": "silent"` and no notes. One file per stem makes "re-transcribe replaces that stem only" and "keep completed stems on failure" fall out of the layout. The folder travels with the song and is covered by job deletion.

### 4. Quantiser

New module `app/pipeline/quantize.py`, pure function `quantize(notes, grid, parts_per_beat) -> list[QNote]`.

- **Grid points.** For beat times `b[0..n]`, each interval `[b[i], b[i+1]]` is divided into `parts_per_beat` equal parts (default 4, allowed 1, 2, 3, 4, 6, 8). A grid point is `(beat_index, part)`. Because points are interpolated inside each real beat interval, tempo drift is followed exactly.
- **Snap.** Start snaps to the nearest grid point. End snaps to the nearest grid point after the snapped start, so a note is at least one step long. Notes before the first beat or after the last clamp to the edge.
- **Monophonic overlap.** For CREPE stems, a note's quantised end is trimmed to the next note's quantised start.
- **Bars.** Bar boundaries come from `bars` (marks of `{beat index, beats per bar}` where the length changes). With no marks: `beats_per_bar` from `beats.user.json`, else 4, counted from beat 0. Each `QNote` carries `bar`, `beat`, `part`, and its length in grid steps.
- **Which grid.** The merged grid that `GET /api/jobs/{id}/beats` serves, read through one shared helper so the quantiser and the click never disagree.

Quantisation runs at request time. It is a few thousand notes against a few hundred beats, so there is nothing to cache and nothing to invalidate when the grid is edited. Alternative considered: storing quantised notes at transcription time. Rejected because every grid edit would leave them stale.

### 5. Exports

- **MIDI** with `mido` (MIT, pure Python). As-played: 480 PPQ, a fixed 120 BPM tempo, note times converted from seconds, so the file is a faithful timing record. Quantised: 480 PPQ, one beat is one quarter note, with a tempo event at every beat set from that beat's real duration and time-signature events from the bar marks. Notes land on exact ticks and the file still plays in time with the audio. Drums on channel 10.
- **MusicXML** with `music21` (BSD-3-Clause, needs Python >= 3.11, which matches `requires-python`). Built from `QNote`s: one `Part` per stem, `TimeSignature` per bar mark, `MetronomeMark` from `bpm`, `KeySignature` from the job's detected key, bass clef for `bass`, percussion clef and unpitched notes for `drums`. `makeNotation` splits notes at bar lines and adds ties. music21 is imported lazily inside the export function; it is slow to import and must not load at startup.

Alternative considered: writing MusicXML by hand. Ties, rests, divisions and chords are exactly the bookkeeping music21 exists for.

### 6. Process and API

- **Worker.** `python -m app.pipeline.notes_worker <device> <stems_dir> <stem,stem,...>`, modelled on `vocal_split_worker.py`: non-persistent, parent watchdog armed, progress on stderr, then `@@DONE@@` or `@@ERROR@@{"message", "code"}`. It groups the requested stems by transcriber, loads each model once, writes each stem's JSON as it finishes, and reports per-stem outcomes as `@@STEM@@{json}` lines. A model that fails to load fails only the stems routed to it. Named `notes_worker` because `transcribe_worker.py` is already the Whisper lyrics worker.
- **Decoding.** Stems are decoded to mono float with the existing ffmpeg loader (`analyze._load_audio_ffmpeg`), at 16 kHz for CREPE and each model's own rate otherwise, so WAV and MP3 stems behave the same.
- **Device.** The device Demucs uses. If a model raises on MPS, the worker retries that model on CPU once and logs it.
- **Job state.** On `Job`: `transcription: "none" | "running" | "done" | "error"`, `transcription_reason`, `transcription_stems: dict[str, "done" | "skipped" | "error"]`. Persisted before the run starts; "running" at startup becomes "error" with reason `interrupted`. Added to `Job.post_hoc_running()` so it excludes vocal split and stem fill, and the reverse.
- **Endpoints** (in a new `app/api/transcription.py`, so `jobs.py` does not grow further; documented in `docs/api.md`):
  - `POST /api/jobs/{id}/transcription` body `{stems?: [..]}` runs a transcription and answers with the job state when it ends, the way the vocal split endpoint does; the job reports `running` and fills in per-stem results meanwhile. 404 unless the job is done; 409 if one is running; busy if a split or fill is running; 422 for an unknown stem; 501 where transcription cannot run; 500 with a reason code when the run ends early.
  - `GET /api/jobs/{id}/transcription?stems=&quantize=0|1&parts=4` returns notes as JSON.
  - `GET /api/jobs/{id}/transcription.mid?stems=&quantize=0|1&parts=4`
  - `GET /api/jobs/{id}/transcription.musicxml?stems=&parts=4`
  - Cancel uses the existing `POST /api/jobs/{id}/cancel`.
- **Availability.** `/api/config` gains `transcription_available`, false on Intel Macs, the way the vocal split is gated, plus `transcription_routes` and the quantiser's `quantize_parts`.
- **Reason codes** in a new `app/core/transcription_outcome.py`, mirroring `vocal_split_outcome.py` and sharing its strings where the meaning is the same: `dependency_missing`, `model_unavailable`, `out_of_memory`, `worker_failed`, `timeout`, `cancelled`, `interrupted`, `unsupported_platform`, `no_beat_grid`.

### 7. Frontend

A **Transcribe** entry in the song's export menu opens a small dialog: stems to transcribe (non-silent ones ticked), then, once done, three downloads (MIDI as played, MIDI quantised, MusicXML) and a grid-resolution choice. Progress and failure reuse the stage text and reason-message pattern of the vocal split. No score or piano-roll view.

### 8. Dependencies and packaging

`torchcrepe`, `piano-transcription-inference`, `mt3-infer`, `mido`, `music21` are added as normal dependencies with the same `sys_platform != 'darwin' or platform_machine != 'x86_64'` marker that `audio-separator` carries, so the Intel Mac lock is untouched. `piano-transcription-inference` pulls in `torchlibrosa`; `mt3-infer` pulls in `transformers`. Model weights go under `MODELS_DIR`, at paths listed in `model_cache.py`, and are checked against their published hash before every load (see Implementation notes).

Alternative considered: an optional extra (`uv sync --extra transcription`). Rejected for now because the desktop runtime pack is one fixed environment and the feature would be invisible to desktop users; revisit if the size is a problem.

## Implementation notes

What building it changed or settled, recorded so the design matches the code.

- **`transformers` must be 4.45.** `mt3-infer` declares `transformers>=4.35`, but its vendored YourMT3+ decoder only runs on the T5 internals of that era. Measured: 4.45.2 transcribes; 4.46.3 and 4.47.1 load and then fail in the decoder (`'NoneType' object is not subscriptable`); 5.x does not import (`transformers.utils.model_parallel_utils` is gone). `pyproject.toml` pins `>=4.45,<4.46` and a test fails if that is lifted.
- **`huggingface-hub` moves from 1.29 to 0.36.** transformers 4.x requires hub below 1.0. The only other user in the lock is `all-in-one-infer` (song sections), which declares an unversioned `huggingface_hub`. The full backend suite passes on it. This is the one change in this work that touches an existing feature's dependency.
- **Checkpoints are verified by hash, not healed.** Design said "through `load_or_heal`". That helper deletes the cached file when a load fails, which suits loaders that trust a file's existence. Here it deleted a good 536 MB checkpoint because the GPU lacked an operator. Each checkpoint is instead hashed against its published MD5 or SHA-256 before loading (once, remembered in a marker file), so a truncated download is refetched before it can fail and a good file is never discarded.
- **Downloads are StemDeck's own.** `piano-transcription-inference` fetches with `wget` into the home folder, and `mt3-infer` clones a Hugging Face Space with `git lfs`. Neither is acceptable in a desktop install, so the adapters download the two checkpoints themselves (Zenodo over HTTPS, and `huggingface_hub` from the authors' model repository) into `MODELS_DIR`.
- **CREPE's search floor is 33 Hz, not 30.** Its lowest pitch bin is C1 (32.7 Hz); a floor below that masks every bin and the tracker returns nothing. A five-string bass's low B (30.9 Hz) is therefore out of its range.
- **Silence is checked before a model loads.** The worker decodes each stem first and records a silent one as skipped without loading its transcriber.
- **A vocal split is refused while a transcription runs,** as well as the reverse.
- **The job's key is stored as the chip shows it** (`E maj`, `G# min`), so the MusicXML writer takes the tonic from the first word.
- **Runtime size.** The development environment grew from 953 MB to 1,278 MB (325 MB) with the five packages and their dependencies. No TensorFlow package is in the lock.
- **YourMT3+ never runs on Apple's MPS.** Design said "the device Demucs uses, with one retry on CPU". On MPS the model works but is unusable: its decoder emits one token at a time, each step has a new tensor shape, and MPS compiles and caches a graph per shape. Measured on 20 s of a real guitar stem: 151 s on the CPU, 481 s on MPS, and the MPS process then took minutes to exit while it freed those graphs. `mt3_device()` maps `mps` to `cpu`; CUDA is used as asked. CREPE stays on MPS, and the piano library only uses a GPU for CUDA.
- **Speed depends on how many notes there are, not how long the audio is.** On an M-series Mac, CPU, with the machine under other load: CREPE about 1 minute per stem for a 3.5 minute song; the piano model about 2 minutes plus its download; YourMT3+ under 3 minutes for the whole drums stem (1,295 hits), 1.9x real time for the "other" stem and 3.5x real time for a dense rock guitar stem (128 notes in 10 s), which is about 12 minutes for the song. The dialog's hint says a song can take half an hour or more.
- **Tracks and staves come out in score order** (voices, guitar, piano, other, bass, drums) when a download names no stems, and in the order asked for when it does.

## Risks / Trade-offs

- **[Piano weights were trained on MAESTRO, a CC BY-NC-SA 4.0 dataset; the code is MIT]** → Write up the basis in `docs/models.md` before release. If it is judged the same case as madmom, set `piano` to `mt3` in the routing table; YourMT3+ transcribes piano with lower accuracy.
- **[YourMT3+ has two license statements: GPL-3.0 on the GitHub repository, Apache-2.0 on the Hugging Face model card and in `mt3-infer`'s vendored copy]** → Both are compatible with AGPL-3.0-only. Record which applies to the code and which to the weights, and check the training datasets' terms for the checkpoint used.
- **[`mt3-infer` is a young third-party package (0.2.0)]** → Pin an exact version, keep it behind one adapter function, and test against a short fixture so a breaking release fails CI, not users.
- **[Vocal note segmentation is the weakest link: slides, melisma and breathy onsets produce wrong note boundaries]** → Thresholds are constants, the segmenter is pure and unit-tested, and the as-played MIDI is always available for fixing by hand.
- **[A wrong beat grid gives confidently wrong notation, and a half-time grid halves every note value]** → Quantised exports state the grid's `confidence` and `detector` in the JSON, the dialog warns below a confidence threshold, and the grid editor already exists to fix it.
- **[One resolution per export garbles swing and triplets at 4 parts per beat]** → Resolution is a choice (3 and 6 for triplet feel). Per-beat tuplet detection is left out.
- **[Separation bleed becomes ghost notes, mostly in `other` and `guitar`]** → Drop notes below a velocity floor and transcribe silent stems as skipped.
- **[Dependency weight: `transformers` and `matplotlib` grow the runtime pack by several hundred MB, and a package change forces a full desktop download]** → Measure the pack size in the dependency task and note it in the release notes; lazy imports keep startup time unchanged.
- **[Memory and time on CPU: YourMT3+ on a five-minute stem is slow]** → Run one model at a time in the worker, release each before loading the next, add `STEMDECK_TIMEOUT_TRANSCRIPTION`, and show per-stem progress.

## Migration Plan

Additive. No stored data changes shape: jobs gain optional fields that default to `"none"`, and a song without `stems/transcription/` behaves as before. Rollback is removing the endpoints and the UI entry; leftover `transcription/` folders are inert and are deleted with their songs.

## Open Questions

- Which YourMT3+ checkpoint `mt3-infer` should load by default (the published set differs in size and in the datasets behind it). Decided in the license task; it changes a config constant, not the design.
- Whether the Transcribe action should also be offered at import time, like the vocal split. Left out of this change.
