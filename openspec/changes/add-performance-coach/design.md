# Design

## Context

- Takes live in `jobs/<id>/takes/<take_id>/` with `audio.wav` (the clean input, mono or stereo) and an optional camera part. The take's position in the song is `placement_sec = first_sample_song_sec - user_nudge_ms / 1000` (`app/api/takes.py`), so a sample of the take maps to a song time without any analysis.
- **I play** exists only as Performance mode state and as `remove_stem` in the render request (`static/js/streamer/recordModel.js`). Nothing stores it on the take today.
- `add-stem-transcription` provides the reference: `stems/transcription/<stem>.json` (raw notes with start, end, pitch and velocity), the transcription worker process with its per-stem routing (`TRANSCRIBE_ROUTES` in `app/core/config.py`), and the beat grid (`beats.json` merged with `beats.user.json`) with the quantiser's bar positions.
- StemDeck has no LLM or cloud service and promises not to upload audio. The Move Coach project (`/Users/backlit/Documents/code/move-coach`) puts measurement in a local helper and the conversation in a Claude Code skill that reads the helper's results; this design follows the same split.

## Goals / Non-Goals

**Goals:**
- Findings a musician can act on, tied to bars, from audio alone.
- Reuse the transcription models and worker; no new dependency.
- A report format stable enough for the skill and for later camera findings to extend.

**Non-Goals:**
- Real-time feedback while recording.
- Judging expression or tone (vibrato quality, swing feel as style); only timing, notes and loudness.
- Phase 2's camera analysis (see the last section); this change leaves room for it but builds none of it.

## Decisions

### Store the part on the take at finish time
The finish request (`POST /takes/{id}/finish`) gains an optional `part` (a stem name); the frontend sends the current I play choice. `PATCH /takes/{id}` accepts `part` for older takes and corrections. Alternative considered: infer the part by comparing the take with every stem's transcription. Rejected as the primary path because it costs a transcription per candidate and fails exactly when the playing is poor; it is kept as the hint in "does not match the Piano part" (compare against the chosen stem only, and if under a quarter matches, say so).

### Transcribe the take with the part's own route, in the existing worker
The take's audio, cut to its span, is sent through the same worker process and route as the stem (`TRANSCRIBE_ROUTES[part]`), so the take and the reference have the same model's biases and their differences are the playing. The worker already handles one stem at a time, model caching and cancellation. For drums, YourMT3+ output is compared by onset and General MIDI key only.

### Align in two stages
1. **Global offset**: cross-correlate onset strength envelopes of take and reference stem audio over the take's span (±500 ms) and remove the best lag. This catches uncorrected latency and a late start, and is reported.
2. **Note matching**: dynamic time warping over note onsets, with a band of ±150 ms and a cost from onset distance plus a pitch term (zero for drums), constrained to be monotonic. A steady drift is absorbed by a linear fit of matched offsets over time; per-bar timing is reported relative to that fit only when the fit's slope is significant, and the drift itself becomes a finding ("you slow down by about 3 BPM over the take").
Alternatives: plain nearest-onset matching (fails on repeated notes and fast runs); audio-to-audio DTW on chroma (does not give note-level misses).

### Score per bar from the beat grid
Bars come from the merged beat grid, the same bars the quantiser and MusicXML use, so "bar 33" means the same bar in the notation view. A matched pair within ±1 semitone of the wrong pitch counts as a wrong pitch, not a miss; an unmatched reference note is missed; an unmatched take note is added. Loudness is the ratio of the take's to the reference's median velocity per bar, compared with the take's overall ratio so a quieter recording level is not a finding.

### Tips from rules, not a model
A small rule table turns measurements into one to five tips, ranked by size of effect: runs of consecutive early or late bars (rushing or dragging a section, named by the song's sections when it has them), runs of missed notes, a section with many added notes, steady drift, uneven loudness against the reference's dynamics. Each tip carries the bars and the numbers it rests on. Rules are deterministic and testable; the conversational layer is the skill's job.

### Report storage and API
`takes/<take_id>/coach/<timestamp>.json`, one file per run, schema-versioned. The take record in the job state lists report ids and the latest summary, so the song's history needs no file scans. Endpoints: `POST /takes/{id}/coach` (202, progress over the existing job events), `GET /takes/{id}/coach` (list), `GET /takes/{id}/coach/{report_id}`, `PATCH .../{report_id}` (corrections: per-bar `intentional` with a note), `GET /jobs/{id}/coach/history?part=`. Deleting a take already removes its folder.

### The skill reads, never listens
`.claude/skills/stemdeck-coach/` documents the endpoints, how to explain each measurement, the questions to ask for findings audio cannot settle (muting, deliberate variation, an alternate voicing), and when to send a correction. It reads only report JSON from `127.0.0.1`, as Move Coach's skill reads its helper.

## Risks / Trade-offs

- [Transcription errors in the reference are blamed on the musician] → The report links each bar to the notation view so the musician can see the reference; the skill asks before treating an isolated miss as real; corrections mark bars intentional.
- [Polyphonic guitar matching is noisy] → Guitar scores count chord tones as a group per onset (hit if most tones match), and the summary states lower confidence for multi-instrument routes.
- [A take recorded with the part not fully muted] → If the take correlates strongly with the stem audio itself, the report warns that the backing may have leaked into the recording.
- [Coach runs are slow on a CPU for long takes] → Progress and cancel; the coach analyses only the take's span, not the whole song.

## Phase 2: camera (a follow-up change, not built here)

A later change, `add-performance-coach-camera`, adds findings from the take's camera part, which Performance already records in sync. It would run MediaPipe hand and pose landmarks locally (as Move Coach's `pose_coach.py` does), per bar, and add camera findings to the same report under a `camera` key: posture (shoulder and neck angle over time), fretting-hand wrist angle and tension proxies, picking or strumming arm range, and whether movement spikes line up with the bars the audio marked as weak. The report schema reserves that key now; nothing reads it in this change.

## Open Questions

- The exact thresholds for "a run of early bars" and for the strip's colours will be tuned on real takes during task 6; they change no spec.
