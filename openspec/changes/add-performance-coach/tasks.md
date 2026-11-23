# Tasks

## 1. The take's part

- [ ] 1.1 Accept an optional `part` (a base or extra stem name of the song) on `POST /takes/{id}/finish` and on `PATCH /takes/{id}`, store it on the take record and in the take's sidecar; verify pytest cases for set, change, unknown stem rejected, and an older take without a part
- [ ] 1.2 Send the current I play choice with finish from `static/js/streamer/` and show the part in the take list; verify a Playwright test records a take with Bass chosen and reads `part: "bass"` back from the API

## 2. Take transcription and alignment

- [ ] 2.1 Cut the take's audio to its span and run it through the transcription worker with the part's route, cancellable, with progress events; verify pytest with a stub transcriber that the take is cut at `placement_sec` and routed like its stem (vocals and bass to CREPE, piano to the piano model, guitar, other and drums to YourMT3+)
- [ ] 2.2 Implement the global offset by onset-envelope cross-correlation within ±500 ms; verify pytest on synthetic audio shifted by 25 ms reports 25 ms (±5 ms)
- [ ] 2.3 Implement monotonic note matching with the ±150 ms band and the pitch term (none for drums), and the drift fit; verify pytest cases: exact copy matches every note, one wrong pitch is a wrong pitch not a miss, a removed note is a miss, an extra note is added, repeated sixteenths at 136 BPM match one to one, a 2% tempo drift is reported as drift and not as per-bar errors

## 3. Scoring, tips and reports

- [ ] 3.1 Score per bar from the merged beat grid (counts, wrong pitches, median and spread of timing, relative loudness), only for bars inside the take; verify pytest against hand-built takes, including a take covering bars 30 to 45 only
- [ ] 3.2 Implement the "too little to judge" outcomes (under two bars, under a quarter matched, likely wrong part, likely backing leak); verify one pytest per outcome checking the message key
- [ ] 3.3 Implement the tip rules (rushing or dragging runs, missed-note runs, added notes, drift, uneven dynamics), ranked, one to five, each with bars and numbers; verify pytest that a take early by about 40 ms in bars 33 to 36 yields that tip first
- [ ] 3.4 Save reports as schema-versioned JSON in `takes/<id>/coach/`, list them on the take record with the latest summary, reserve the `camera` key; verify pytest that renaming or nudging a take keeps its reports and deleting it removes them

## 4. API

- [ ] 4.1 Add `POST /takes/{id}/coach` (202, refused with a clear message when the part has no transcription, the song has no beat grid, or transcription is unavailable), `GET` list and single report, and `PATCH` corrections (per-bar intentional with a note); verify pytest for each endpoint, including the CSRF guard and that no response contains audio
- [ ] 4.2 Add `GET /jobs/{id}/coach/history?part=` and document all coach endpoints in `docs/api.md`; verify pytest for date order and the part filter

## 5. Review UI

- [ ] 5.1 Add the Coach action to the take review (hidden where transcription is unavailable; asks for the part when missing; offers Transcribe when the part has no notes), with progress and cancel; verify Playwright tests for the three entry states and for cancel leaving earlier reports
- [ ] 5.2 Draw the bar strip over the take timeline and the summary and tips panel; clicking a bar or tip seeks the song and the take; verify Playwright tests for the colours of a stubbed report, bar click and tip click positions, and a corrected bar's note
- [ ] 5.3 Show the song's coach history per part; verify a Playwright test with three stubbed reports in date order
- [ ] 5.4 Add every new string to all language tables in `static/js/i18n.js` and Guide entries for new controls; verify the existing i18n completeness test and `tests/e2e/help-mode.spec.mjs` pass

## 6. Real takes and the skill

- [ ] 6.1 Record real takes on at least bass and guitar against a transcribed song (one clean, one deliberately rushed in a known section, one with missed notes) and tune thresholds until the reports name the known problems and nothing else prominent; record the takes used and the outcomes in `design.md`
- [ ] 6.2 Write `.claude/skills/stemdeck-coach/` (endpoints, how to explain each measurement, the questions for findings audio cannot settle, when to send a correction); verify by running it against a real report and saving the transcript summary in `design.md`
- [ ] 6.3 Run `uv run ruff check app/ tests/`, the pytest suite, `tests/js`, and the Performance and coach Playwright specs with the parallel runner; verify all pass or record unrelated failures with evidence

## Workflow follow-up

- Propose `add-performance-coach-camera` (phase 2: MediaPipe hand and pose findings under the report's `camera` key) once this change is archived.
