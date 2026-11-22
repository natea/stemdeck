# Design

## Context

See proposal.md for motivation and measurements. What shapes the approach:

- **One seam already exists.** `app/pipeline/notes.py` `transcribe_stems(job, stems_dir, names)` starts a worker process, reads `@@STEM@@` lines and returns each stem's outcome; `app/api/transcription.py` turns that into job state. The worker (`notes_worker.run`) decodes a stem, checks for silence, loads the transcriber it is routed to and writes `stems/transcription/<stem>.json` through `write_notes`. Everything after that file exists (quantising, MIDI, MusicXML) reads only the file.
- **The server machine is not a StemDeck library.** On the DGX Spark the whole app was installed to prove the path, but the request here is for transcription only.
- **That machine needs a different PyTorch.** StemDeck pins 2.6; the Spark's GB10 GPU needs 2.9.1 with CUDA 13, installed by hand after `uv sync`. `torchaudio` 2.9 cannot save without `torchcodec`; transcription does not save audio, and separation's save has a fallback since `eb9e6b4`.
- **Settings pattern.** `app/core/settings.py` holds persisted settings with getters and setters, served by `/api/settings`, with environment variables seeding defaults.
- **StemDeck has never sent audio anywhere.** The README says so in four places. A request guard (`app/core/csrf.py`) protects StemDeck's own API from other websites; it does not authenticate a second machine.
- **Stems are small.** MP3 by default: about 3 MB for 3.5 minutes.

## Goals / Non-Goals

**Goals:**
- Reuse the worker's transcription code unchanged on the server, so local and remote results cannot drift apart.
- A remote result is indistinguishable downstream: same file, same shape.
- The link is boring: plain HTTP requests, one per stem, no shared filesystem, no message queue.
- Off by default, explicit about where audio goes, and safe to expose on a home network or tailnet.

**Non-Goals:**
- Remote separation, lyrics or sections.
- A server usable by untrusted callers on the open internet. It is for a machine the user runs, on a network they control.
- Several servers, queues across users, accounts.
- Keeping the server's install in step with the client automatically.

## Decisions

### 1. Where the split is: the server runs one stem per request

```
   Mac (StemDeck)                                   Spark (transcription server)
   --------------                                   ----------------------------
   transcribe_stems()
     local runner  --> notes_worker (as today)
     remote runner --> POST /v1/transcriptions  --> decode, silence check,
          one stem      audio + stem name            route, transcribe
          at a time <-- progress lines, result  <--  (persistent worker)
     write_notes()  (same file as local)
```

The remote runner sits beside the local one in `notes.py` and returns the same outcome dict, so `app/api/transcription.py` and the job state are untouched. It sends stems one at a time, in the same cheapest-first order, and writes each result with `write_notes` as it arrives: a run that dies half way keeps what it finished, exactly as locally.

Alternative considered: one request with all stems. Rejected: one large upload, no per-stem result until the end, and a dropped connection loses everything.

Alternative considered: point the Mac at a full StemDeck on the server and import the song there. Rejected: that is the "run StemDeck on the Spark" option, with a second library.

### 2. Protocol

Versioned, small, and the same code path for progress and result.

- `GET /v1/health` → `{protocol: 1, version, device, transcribers: [...], routes: {...}, busy: bool}`.
- `POST /v1/transcriptions` multipart: `stem` (name), `audio` (the stem file as stored, MP3 or WAV), optional `transcriber` (the client's route for that stem, so a client's `STEMDECK_TRANSCRIBE_<STEM>` override is honoured). The response is streamed newline-delimited JSON: `{"progress": "..."}` lines as the worker reports them (each resets the client's stall timer), then exactly one final line: `{"result": {"transcriber", "model", "duration", "notes": [...], "skipped": null | "silent"}}` or `{"error": {"code", "message"}}`.
- Closing the connection is the cancel.
- `Authorization: Bearer <token>` on both. `401` without it. `409 {"code": "busy"}` when a transcription is running. `426`-style refusal carried as `{"error": {"code": "incompatible"}}` when the client's `X-StemDeck-Protocol` header is not one the server speaks; the client also checks `/v1/health` before sending any audio.

Streaming a single response instead of create-then-poll keeps the server stateless between requests: there is no job table to clean up, and a dead client is noticed as a closed socket.

### 3. The server process

`python -m app.transcribe_server --host 127.0.0.1 --port 8766` (a FastAPI app of two routes, served by the uvicorn StemDeck already depends on).

- It refuses to start with a non-loopback `--host` unless `STEMDECK_TRANSCRIBE_SERVER_TOKEN` is set (minimum length enforced), and prints a generated token suggestion when none is given.
- Transcription runs in a **persistent child process** (a serve loop added to `notes_worker`, reading one request per line on stdin as `demucs_worker` does), so models stay loaded between stems and between runs, and are unloaded after the idle period StemDeck already uses. Cancelling kills that child; the next request starts a fresh one. The parent stays responsive to health checks while a model computes.
- Each request's audio is written to a per-request temp folder under the server's data directory, decoded there with ffmpeg, and the folder is removed in a `finally`, including on disconnect.
- One transcription at a time behind a lock; a second request gets `busy` at once.
- It imports none of StemDeck's library, registry or job code.

Alternative considered: add the routes to the main StemDeck app. Rejected: it would bring the library, the queue and the browser request guard onto a machine that needs none of them, and blur who may call what.

### 4. Transport and trust

- **HTTP with a bearer token**, intended for a LAN or a tailnet (the Spark is reachable as a Tailscale name, where the link is already encrypted). `https://` addresses work too if the user puts a certificate in front of it; StemDeck's client verifies certificates normally.
- StemDeck warns, in Settings, when the address is plain `http://` to a host that is neither loopback, a private-range address nor a `.ts.net` name: the token and audio would cross a network in the clear.
- The token is compared in constant time, never logged, and masked when settings are read back (`"sd-****abcd"`).
- The client sends no cookies and no song metadata, and does not follow redirects, so a mistyped address cannot bounce the audio elsewhere.

### 5. Settings and where a run goes

In `app/core/settings.py`, with environment variables seeding them:

| Setting | Env | Meaning |
|---|---|---|
| `transcribe_remote_url` | `STEMDECK_TRANSCRIBE_REMOTE_URL` | server address, empty = off |
| `transcribe_remote_token` | `STEMDECK_TRANSCRIBE_REMOTE_TOKEN` | access token |
| `transcribe_remote_enabled` | (derived) | on when a URL is set; a switch in Settings turns it off without forgetting the address |

`/api/config` gains `transcription_runs_on: "local" | "remote" | null` and `transcription_remote_host` (host only, for display), and `transcription_available` becomes true when either local transcription works or a server is enabled.

`POST /api/jobs/{id}/transcription` gains an optional `where: "local" | "remote"`, defaulting to the setting. That is how "Run on this computer instead" is expressed after a failed remote run, without a hidden fallback.

`POST /api/settings/transcription-server/test` calls `/v1/health` with the given address and token and returns what it found, or one of the reason codes below.

### 6. Reason codes

Added to `app/core/transcription_outcome.py`, each with a fixed sentence: `remote_unreachable`, `remote_unauthorized`, `remote_busy`, `remote_incompatible`, `remote_lost` (the link dropped mid-stem). A server-side failure for one stem keeps the server's own code (`model_unavailable`, `out_of_memory`, ...). Run-level codes end the run; stem-level codes mark the stem, as today.

### 7. What records that a stem was transcribed elsewhere

`stems/transcription/<stem>.json` gains `"ran_on": "local" | "remote"` (absent in files written before this change, read as local). The job's per-stem outcome carries the same field, and the dialog shows it. The server's host name is not stored in the song: it is machine configuration, not song data.

### 8. Frontend

- Settings: a "Transcription server" section with address, token, an on/off switch, Test, and one sentence saying that with this on, the audio of the stems you transcribe is sent to that address.
- Transcribe dialog: a line under the hint, "Transcribing on <host>" or "Transcribing on this computer", and after a run-level remote failure a button "Run on this computer instead" where `transcription_available` is true locally.
- README: the "your audio is not uploaded" statements gain "unless you set up your own transcription server, in which case stems you transcribe are sent to it".

### 9. Running the server on the Spark

`docs/transcription-server.md` records what was done by hand and found to work: `uv sync --python 3.12`, then replace the three PyTorch packages (`torch==2.9.1+cu130` and `torchvision==0.24.1+cu130` from the cu130 index, `torchaudio==2.9.1` from PyPI, each without re-resolving the rest), set the token, start the server on the tailnet address. It also says what was measured there and that 2.6 does not drive that GPU. Packaging that swap (an extra, a lock per platform, or a Docker image) is left out.

## Risks / Trade-offs

- **[Client and server on different versions give different notes or fail oddly]** → The protocol version is checked before audio is sent, and `/v1/health` reports the app version and model names, which the result also carries and the notes file records.
- **[Audio leaves the machine for the first time]** → Off by default, an explicit address typed by the user, a sentence at every point of use, only stem audio sent, nothing kept on the server.
- **[A token over plain HTTP on a hostile network]** → Warned about in Settings; tailnet and LAN are the intended use; https is supported.
- **[The server's persistent worker holds GPU memory other jobs want]** → Idle unload, plus a `--no-keep-loaded` flag. On the Spark a vLLM server had to be stopped to make room; the doc says to check free memory.
- **[Upload of WAV stems is ten times larger]** → Still tens of megabytes on a LAN. The client sends the file as stored and does not re-encode; revisit only if it proves slow over a tailnet relay.
- **[Cancel kills warm models]** → Accepted: cancels are rare and a reload is seconds on a GPU.
- **[Two StemDeck machines pointing at one server]** → The second gets `busy` and says so; no queue is built for a case nobody has asked for.
- **[The server's install drifts, since its PyTorch is swapped by hand]** → Documented exactly, and the health check surfaces the versions.

## Migration Plan

Additive. With no server configured nothing changes. Notes files without `ran_on` read as local. Rollback is turning the setting off; removing the code leaves existing notes valid.

## Open Questions

- Whether the server should also be offered as a Docker image. Left for after the hand-installed path has been used for a while.
