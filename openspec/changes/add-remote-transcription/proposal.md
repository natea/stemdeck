# Proposal

## Why

Transcribing a song's stems is slow on the machine most people run StemDeck on. Measured on one 3.5 minute rock song: about 20 minutes on an M-series Mac, where YourMT3+ has to run on the CPU, against 3 minutes 36 seconds on an NVIDIA machine on the same network, where the guitar stem alone took 34 seconds instead of about 10 minutes. Running all of StemDeck on that second machine works, but then the library, the player and the files live there too. People who have a GPU box want to keep StemDeck where they sit and borrow the other machine for this one job.

## What Changes

- Add a **transcription server**: a small service, started on a second machine the user owns, that accepts one stem's audio and returns its notes, using the same transcribers and routing as local transcription. It keeps no library and no audio after answering.
- Add a **remote transcription setting** in StemDeck: the server's address and an access token, off by default, with a Test button that reports the server's version, device and transcribers.
- When the setting is on, **Transcribe sends each chosen stem to the server** instead of loading models locally. Results are stored in the song's folder exactly as local results are, so quantising, MIDI and MusicXML are unchanged.
- **Transcription becomes available on machines that cannot run it locally** (Intel Macs) once a server is configured.
- If the server cannot be reached, is busy, refuses the token or speaks another protocol version, the run ends with a reason that says so, and the dialog offers to run on this computer instead where that is possible. StemDeck never switches to the other place silently.
- Cancel works across the link: cancelling in StemDeck stops the work on the server.
- **Say plainly where audio goes.** The setting, the Transcribe dialog and the README state that with this on, stem audio is sent to the address the user entered, and nowhere else. StemDeck's "your audio is not uploaded" statement is reworded to stay true.
- Document running the server, including the NVIDIA ARM case (DGX Spark), which needs a newer PyTorch than StemDeck pins.

Not in this change: sending separation or any other stage to the server, discovering servers automatically, several servers or load balancing, a hosted service, and a Docker image for the server.

## Capabilities

### New Capabilities
- `remote-transcription`: transcribing a song's stems on a second machine the user runs: the server's behaviour, what StemDeck sends and stores, how it is configured and secured, and what happens when the link fails.

### Modified Capabilities

None as a delta file. `stem-transcription` (introduced by `add-stem-transcription`, not yet archived) says transcription is not offered where its models cannot run. This change widens that to "or where a transcription server is configured"; the requirement is stated in the new capability and the older spec should be amended when both are archived.

## Impact

- **Backend, StemDeck side**: a remote runner beside the local worker in `app/pipeline/notes.py`, chosen by the setting; new settings in `app/core/settings.py` and `/api/settings`; new reason codes in `app/core/transcription_outcome.py`; `/api/config` reports where transcription will run.
- **Backend, server side**: a new entry point (`python -m app.transcribe_server`) reusing `app/pipeline/notes_worker.py` and `notes_adapters.py`. Same repository, same dependencies, no new packages on either side.
- **Frontend**: a section in Settings, a line in the Transcribe dialog saying where the run will happen, strings in ten languages.
- **Privacy and security**: the first feature that sends audio off the machine, to an address the user typed. Off by default, token required, and the server refuses to start on a non-loopback address without a token.
- **Network**: one HTTP connection per stem. A stem as stored is about 3 MB (MP3) or 35 MB (WAV) for a 3.5 minute song.
- **Docs**: README privacy wording, `docs/configuration.md`, `docs/api.md`, a new `docs/transcription-server.md`.
- **Depends on** `add-stem-transcription`.
