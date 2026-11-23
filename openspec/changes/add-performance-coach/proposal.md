# Proposal

## Why

Performance mode lets a musician take their own part out of the backing track (**I play**), play it, film it and review the take, but the review is only their own ears. The `add-stem-transcription` change already gives StemDeck the exact notes of that part and the song's beat grid, which is everything a coach needs to say which bars were early, which notes were wrong and where the playing drifted.

This change depends on `add-stem-transcription` and is built after it.

## What Changes

- Record on every new Performance take which stem the musician played (the **I play** choice at the moment of recording), so a take knows what it should be compared with. Takes recorded before this change, or with nothing chosen, can be given a part afterwards.
- Add a **Coach** action on a take. It runs on the musician's own machine and:
  - transcribes the take's audio with the same model StemDeck uses for that stem (CREPE for vocals and bass, the piano model for piano, YourMT3+ for guitar and other; drums compare onsets only);
  - lines the take's notes up with the stem's reference notes over the span the take covers, allowing for a loose start and steady drift;
  - measures, per bar: notes hit, missed and added, wrong pitches, timing against the beat grid (early or late, in milliseconds, and how steady), and loudness relative to the reference;
  - writes a **coach report**: an overall summary, the bars that need work most, and a short list of plain tips built from those measurements (for example "you rush the fills in bars 33 to 36 by about 40 ms").
- Show the report in Performance mode: a per-bar strip over the take timeline, coloured by how well each bar went, that seeks the take and the song to that bar when clicked; the summary and tips beside it.
- Keep every report, so a song shows how the musician's takes of it have improved over time (timing, accuracy, per section).
- Serve the report from the local API, so an optional **Claude Code skill** can talk the musician through it, ask about what audio cannot reveal ("were you palm-muting in bar 12?"), correct the report when the answer changes a finding, and suggest what to practise next. The skill reads the report only; the audio never leaves the machine.

Not in this change: the camera (posture and hand analysis from the take's video, planned as a follow-up change), live feedback while playing, scoring vocals' lyrics or tone, comparing against anything other than the song's own stem, and any cloud service.

## Capabilities

### New Capabilities
- `performance-coach`: analysing a recorded Performance take against the transcribed part it replaced, the measurements and tips in the coach report, how the report is shown and kept over time, and what happens when a take has no part, the stem has no transcription, or the take is too short or too quiet to judge.

### Modified Capabilities

None. The `stem-transcription` capability is used as it is; the take's played part is new data owned by `performance-coach`.

## Impact

- **Backend**: a coach module under `app/pipeline/` (take transcription through the existing transcription worker, alignment, per-bar scoring, tip rules), endpoints in `app/api/takes.py` (set a take's part, run the coach, read reports), the take record in the job state gains the played part and a list of reports, stored as JSON in the take's folder.
- **Frontend**: the record path in `static/js/streamer/` sends the I play choice when a take is finished; the review gains the bar strip and the report panel; strings in `static/js/i18n.js` in every language table.
- **Claude Code skill**: a new skill under `.claude/skills/` (development tooling, not shipped in installers) that reads the report endpoint and coaches.
- **Dependencies**: none new. It reuses the transcription models and the beat grid.
- **Time and disk**: a coach run transcribes one take (seconds to a few minutes on a CPU, as transcription does for one stem); a report is a few kilobytes.
- **Platforms**: not offered where transcription is not (Intel Macs).
- **Privacy**: unchanged. Analysis is local, and nothing is uploaded; the skill is optional and sees only the report's numbers and text.
