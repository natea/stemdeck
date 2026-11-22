# Tasks

## 1. Server

- [ ] 1.1 Add a serve loop to `app/pipeline/notes_worker.py` (one JSON request per stdin line: audio path, stem, transcriber; progress and one result per request on stderr; models kept loaded between requests) without changing the one-shot mode; verify unit tests drive two requests through one process with fake transcribers and see one model load, and the existing worker tests pass unchanged
- [ ] 1.2 Implement `app/transcribe_server.py` (`GET /v1/health`, `POST /v1/transcriptions` streaming newline-delimited JSON, bearer token checked in constant time, protocol header check, one-at-a-time lock answering `busy`, per-request temp folder removed in `finally`, child killed on client disconnect, idle unload, `--host`, `--port`, `--no-keep-loaded`); verify tests with a stub child cover a result, a silent stem, an unknown stem, a wrong token, a second caller, an incompatible protocol and a mid-request disconnect that leaves no temp file
- [ ] 1.3 Refuse to start on a non-loopback host without `STEMDECK_TRANSCRIBE_SERVER_TOKEN` of at least the minimum length; verify a test starts it both ways and reads the refusal
- [ ] 1.4 Verify the server module imports nothing from the library, registry or jobs API (assert on `sys.modules` in a test) and that importing `app.main` still loads no transcription library
- [ ] 1.5 Document the two endpoints in `docs/api.md` and write `docs/transcription-server.md` (install, token, starting it, the NVIDIA ARM PyTorch swap and what was measured, checking free GPU memory); verify the documented start command runs as written on the Mac

## 2. Client

- [ ] 2.1 Add `transcribe_remote_url`, `transcribe_remote_token` and the on/off switch to `app/core/settings.py` and `/api/settings`, seeded from the two environment variables, with the token masked on read and absent from logs; verify tests for defaults, env seeding, persistence, masking, and that a log capture of a full run contains no token
- [ ] 2.2 Add the remote reason codes and their sentences to `app/core/transcription_outcome.py`, and document the variables in `docs/configuration.md`; verify the test that every code has a message still passes and the frontend table test fails until 4.1 adds the client strings
- [ ] 2.3 Implement the remote runner in `app/pipeline/notes.py` (health and protocol check before any audio, one stem per request in cheapest-first order, stall timer reset by progress lines, `write_notes` with `ran_on: "remote"` as each result arrives, no redirects, no cookies, cancel by closing the connection); verify tests against an in-process fake server cover a full run, a per-stem server error, unreachable, unauthorized, busy, incompatible, a link lost after one stem, a stall, and a cancel during the second stem
- [ ] 2.4 Choose the runner in `transcribe_stems` from the setting or the request's `where`, add `where` to `POST /api/jobs/{id}/transcription`, record `ran_on` in the per-stem outcome, and never fall back on its own; verify endpoint tests for remote by setting, `where: "local"` overriding it, a remote failure leaving existing notes and the song done, and no local model start after a remote failure
- [ ] 2.5 Make `transcription_available` true when a server is enabled, add `transcription_runs_on` and `transcription_remote_host` to `/api/config`, and add `POST /api/settings/transcription-server/test`; verify tests for an Intel Mac with and without a server, and for Test returning the server's details and each failure reason
- [ ] 2.6 Verify with a test that a remote request body holds only the audio, the stem name and the transcriber, and no title, source, tag or other stem

## 3. Both ends together

- [ ] 3.1 Add an integration test that starts the real server on a loopback port with fake transcribers and runs a real StemDeck transcription against it through the API; verify notes land in `stems/transcription/`, the quantised MIDI and MusicXML downloads work from them, and a cancel stops the server-side work
- [ ] 3.2 Verify a notes file written before this change (no `ran_on`) reads as local, and one written remotely round-trips through the registry rebuild

## 4. Frontend

- [ ] 4.1 Add the "Transcription server" section to Settings (address, token, switch, Test, the sentence about where audio goes, the plain-HTTP warning for a host that is not loopback, private or `.ts.net`) with strings in ten languages and a Guide entry; verify `node --check`, the node string test, and a Playwright test that saves a server, tests it against a stubbed endpoint, and sees the masked token
- [ ] 4.2 Show "Transcribing on <host>" or "Transcribing on this computer" in the Transcribe dialog, mark each stem as transcribed here or on the server, show the remote reasons, and offer "Run on this computer instead" only where local transcription is available; verify Playwright tests for each remote reason, for the offer on a Mac that can run locally, and for its absence where it cannot
- [ ] 4.3 Reword the README's "your audio is not uploaded" statements (four places) to stay true with this setting, and add the feature to the feature list; verify each place was changed and none still claims audio never leaves the machine without the qualification

## 5. On the real machines

- [ ] 5.1 Start the server on the Spark on its tailnet address with a token, point the Mac's StemDeck at it, and transcribe the test song's six stems; verify all six finish, the Mac loads no transcription model (process list during the run), and record the total time in `design.md`
- [ ] 5.2 On that run: cancel during the guitar stem and verify GPU use on the Spark drops within seconds; stop the server mid-run and verify the Mac reports the link was lost and keeps finished stems; give a wrong token and verify the refusal
- [ ] 5.3 Compare the six stems' notes from the Spark with the same stems transcribed locally on the Mac; verify the note counts agree within a few percent and record the differences, since the two run different PyTorch versions and devices
- [ ] 5.4 Verify after the runs that the Spark's server data directory holds no audio and no notes
- [ ] 5.5 Run `uv run ruff check app/ tests/`, `uv run ruff format --check app/ tests/`, `uv run pytest tests/ -q`, every `tests/js/*.test.mjs` and the Playwright specs for transcription and settings; verify all pass, or list each failure that also fails on the base branch
- [ ] 5.6 Run `openspec validate add-remote-transcription --strict`; verify it reports no errors

## Workflow follow-up

- When this change and `add-stem-transcription` are archived, amend the `stem-transcription` spec's "offered only where it can run" requirement to include a configured transcription server.
- Decide whether the full StemDeck install left in `~/stemdeck` on the Spark stays, or is replaced by the server alone.
- Restart the `qwen38-flash-next` container on the Spark when transcription is not in use, if it is still wanted.
