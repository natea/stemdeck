# HTTP API

<sub>[Back to the README](../README.md)</sub>

The endpoints the web app itself uses. They are not a stable public interface and can change between releases.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Server health and version info |
| POST | `/api/jobs` | JSON `{url, stems?}` or multipart `file + stems` → `{job_id}` |
| GET | `/api/jobs` | List completed (library) jobs |
| GET | `/api/jobs/{id}` | Job state snapshot |
| GET | `/api/jobs/{id}/events` | SSE stream of job state |
| POST | `/api/jobs/{id}/cancel` | Terminate active subprocess and cancel job |
| PATCH | `/api/jobs/{id}/sections` | Save waveform section markers for a job |
| PATCH | `/api/jobs/{id}/timeline-tags` | Save the timeline markers for a job: JSON `{timeline_tags: [{id, name, time}]}`, the whole list, stored in time order (#1075) |
| GET | `/api/jobs/{id}/stems/{name}.wav` | Stream a single stem as the song stores it: WAV, or MP3 (`audio/mpeg`) for a song stored as MP3 (#783) |
| GET | `/api/jobs/{id}/stems/{name}.mp3` | A stem as MP3: the stored file for a song stored as MP3, else a cached transcode |
| GET | `/api/jobs/{id}/stems/all.zip` | The chosen stems (and takes) as one ZIP, named after the song. Query: `format`, `stems`, and the click options. `reaper=1` (default off) adds `<song>.rpp`, a REAPER project with one track per file in the zip (the click too), at the stems' sample rate and the beat grid's median tempo (120 without a grid), each file named relative to the project; the download is then named `<song>_reaper.zip`. Without it the zip is unchanged (#1071) |
| GET | `/api/jobs/{id}/video.mp4` | Mux the current mix with the source video (MP4 upload or YouTube) into an MP4 |
| DELETE | `/api/jobs/{id}` | Remove job dir from disk (terminal jobs only) |
| POST | `/api/jobs/{id}/transcription` | Transcribe stems of a finished song into notes. JSON `{stems?: [name, ...]}`; without `stems`, every stem the song has (a silent one is recorded as skipped). Each stem goes to the transcriber it is routed to (`transcription_routes` in `/api/config`). Answers when the run ends, with the job state; meanwhile the job reports `transcription: "running"` and fills in `transcription_stems` as each stem finishes. A stem that fails is reported there with a reason code and does not stop the others. `404` unless the job is done, `409` while a run, a vocal split or a stem fill is in progress, `422` naming a stem the song does not have, `501` with `transcription_reason: "unsupported_platform"` where transcription cannot run. A run that ends early (cancelled, stalled, crashed) answers `500` with `transcription_reason`; the song stays done and finished stems keep their notes. Stop it with `POST /api/jobs/{id}/cancel` |
| GET | `/api/jobs/{id}/transcription` | The notes as JSON, per stem: `{start, end, pitch, velocity}` in seconds as transcribed, or with `quantize=1` snapped to the song's beat grid, each note then also carrying `bar`, `beat`, `part`, `step` and `steps`. Query: `stems` (comma-separated, default every transcribed stem), `quantize`, `parts` (parts per beat: 1, 2, 3, 4, 6 or 8, default 4). Also `quantize_available` and the grid's `confidence`, `detector`, `bpm` and `edited`. Quantising is worked out per request from the stored notes and the current grid, so an edited grid needs no new run. `404` when nothing is transcribed, `409` with `transcription_reason: "no_beat_grid"` for `quantize=1` on a song without a grid |
| GET | `/api/jobs/{id}/transcription.mid` | The transcription as one Standard MIDI File, a track per stem named after it, drums on channel 10, named after the song. As played by default (a fixed 120 BPM used only as a ruler). With `quantize=1` the notes sit on the beat grid and the file carries a tempo event per beat and time signatures from the grid's bars, so it lines up with a DAW's bars and still plays in time with the audio; whatever precedes the first beat is a short lead-in bar. Query: `stems`, `quantize`, `parts`. Stems with no notes are left out |
| GET | `/api/jobs/{id}/transcription.musicxml` | The quantised transcription as a MusicXML score, a part per stem: bars and time signatures from the beat grid, a tempo marking, the detected key as the key signature, bass clef for bass, percussion notation for drums, ties across bar lines. Query: `stems`, `parts`. `409` with `transcription_reason: "no_beat_grid"` on a song without a grid |
