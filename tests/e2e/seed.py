"""Build a jobs directory containing finished tracks, for the browser tests.

The point is that the tests talk to the real backend: real Range requests for
stems, the real registry, the real endpoints. Only the pipeline is skipped,
because running demucs to test a menu would be absurd.

The stems are genuine PCM16 WAVs rather than placeholder bytes. The chunked
audio engine parses WAV containers itself, so a file that is not really a WAV
loads with no duration and the studio comes up without playback -- which is the
#358 failure mode, and it would make every test here fail for the wrong reason.

Each artifact has to live where the real pipeline puts it -- both peaks.json and
beats.json under stems/ -- or the endpoint that serves it 404s and the feature
it drives is quietly untestable. Both were in the job root once: the studio fell
back to decoding every stem for its waveforms, and the click track never
appeared at all.

There are two jobs, and they deliberately share one `source_url`. That is the
whole shape of #542: the catalog deduplicates imports by source URL, so a second
job for a URL the library already knows is what makes the dedup branch run at
all. Processing the same link twice is ordinary user behaviour, and until #542
it silently evicted a trashed track. A fixture with a single job cannot reach
that code path.

The sibling is shorter than the fixture track. Nothing needs six seconds of it,
and the tone generator is a per-sample Python loop, so the extra seconds are
paid on every single run of the suite.

Both jobs are real and complete -- stems, peaks and beats -- so a later test can
open either one. A half-built second job would look usable in the registry and
fail only once someone clicked it.

Usage:  python tests/e2e/seed.py <jobs-dir>
"""

from __future__ import annotations

import json
import math
import os
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

JOB_ID = "e2e0deadbeef"
TITLE = "E2E Fixture Track"
DURATION_SEC = 6

# A second extraction of the same source. Same `source_url` as the fixture
# track, which is the point: see the module docstring.
SIBLING_JOB_ID = "e2e0cafebabe"
SIBLING_TITLE = "E2E Fixture Track (again)"
SIBLING_DURATION_SEC = 2

# The shape a real upload has: "local:" and the title, which the server has
# already stripped of its extension. This once read "local:e2e-fixture.wav",
# which no upload ever produces, and the format icon passed against it while
# never appearing for a real file (#690).
SOURCE_URL = "local:e2e-fixture"

# A finished song whose stems are stored as MP3 (#783), the way the pipeline
# leaves one: <name>.mp3 only, the WAVs gone, the job recording "mp3". Its own
# source, so it never meets the dedup branch above, and dated before the other
# two, so it sorts after them wherever the library sorts by date.
MP3_JOB_ID = "e2e0f00dface"
MP3_TITLE = "E2E MP3 Track"
MP3_SOURCE_URL = "local:e2e-mp3-fixture"
MP3_KBPS = 128
MP3_CREATED_AT = 1690000000.0
# The MP3 song is also the transcribed one (openspec change
# add-alphatab-notation): it carries notes for a voice, a guitar, a bass and
# drums, stored the way the transcription worker stores them, so the Notation
# view's endpoints answer for real. Its own song rather than a fourth one,
# because the library adopts every server song it does not know at startup,
# and specs across the suite are written against the three there are.
# Six seconds at 120 BPM is three bars of 4/4: bar lines at 0, 2 and 4 s,
# which is what the cursor tests count against. The guitar plays low Ds,
# below a guitar in standard tuning, so the song is in drop D: the tab leaves
# them off until the tuning is changed. There is no guitar stem to hear; the
# Notation view reads notes, not audio.
NOTATION_KEY = "D min"
NOTATION_SCALE = "Minor"
STEMS = ["vocals", "drums", "bass", "other"]
SAMPLE_RATE = 44100
CHANNELS = 2


def _wav_bytes(freq: float, seconds: int = DURATION_SEC) -> bytes:
    """A short stereo PCM16 tone. Audible content matters: silence would make a
    broken mix indistinguishable from a working one if these tests ever grow
    real audio assertions."""
    frames = SAMPLE_RATE * seconds
    body = bytearray()
    for i in range(frames):
        value = int(12000 * math.sin(2 * math.pi * freq * i / SAMPLE_RATE))
        body += struct.pack("<hh", value, value)

    block_align = CHANNELS * 2
    fmt_chunk = struct.pack(
        "<HHIIHH", 1, CHANNELS, SAMPLE_RATE, SAMPLE_RATE * block_align, block_align, 16
    )
    chunks = b"fmt " + struct.pack("<I", len(fmt_chunk)) + fmt_chunk
    chunks += b"data" + struct.pack("<I", len(body)) + bytes(body)
    return b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks


def _peaks(points: int = 400) -> list[list[float]]:
    """Matches what the backend writes: min/max pairs per bucket, so the studio
    renders overview waveforms from peaks instead of falling back to decoding
    every stem in the browser."""
    out = []
    for i in range(points):
        amp = abs(math.sin(i / 18.0)) * 0.8
        out.append([round(-amp, 4), round(amp, 4)])
    return out


def _build_job(jobs_dir: Path, job_id: str, title: str, seconds: int) -> dict:
    """Write one finished job's files and return its registry record."""
    stems_dir = jobs_dir / job_id / "stems"
    stems_dir.mkdir(parents=True, exist_ok=True)
    # The upload the runner keeps beside a finished job. Its extension is where
    # the server finds the format of a job recorded before source_format
    # existed, which the registry below deliberately is.
    (jobs_dir / job_id / "source.wav").write_bytes(_wav_bytes(220.0, 1))

    for index, name in enumerate(STEMS):
        (stems_dir / f"{name}.wav").write_bytes(_wav_bytes(220.0 * (index + 1), seconds))

    (stems_dir / "peaks.json").write_text(
        json.dumps({name: _peaks() for name in STEMS}), encoding="utf-8"
    )
    # stems/beats.json, not <job>/beats.json: that is where the pipeline writes
    # it and the only place GET /api/jobs/{id}/beats looks (_beats_paths). Put
    # it in the job root and the endpoint 404s, the studio reports "No beat grid
    # for this track", and every click-track control stays disabled -- so the
    # click track, the count-in and the grid editor were untestable in a browser
    # while looking, from the fixture, as though they were covered.
    #
    # Shape matches what beatgrid.py emits, `bars` included: with no bar marks
    # the accent mode falls back to "Auto (none found)" and the detected-meter
    # path never runs.
    beats = [round(i * 0.5, 3) for i in range(seconds * 2)]
    (stems_dir / "beats.json").write_text(
        json.dumps(
            {
                "version": 1,
                "source": "drums",
                "detector": "e2e-fixture",
                # One 4/4 region from the first beat: 120 BPM, a downbeat every
                # 2 s. Enough for "Auto (detected)" and a one-bar count-in.
                "bars": [{"beat": 0, "beats_per_bar": 4}],
                "bpm": 120.0,
                "duration": float(seconds),
                "confidence": 95,
                # The grid editor snaps dragged beats onto these.
                "onsets": beats,
                "beats": beats,
            }
        ),
        encoding="utf-8",
    )

    # Field names are the dataclass's, not the API's: from_record filters on
    # Job's own fields, so "stage" or "duration" would be silently dropped and
    # the track would load without a duration.
    return {
        "id": job_id,
        "status": "done",
        "progress": 1.0,
        "stage_message": "Done",
        "title": title,
        "duration_sec": float(seconds),
        "source_url": SOURCE_URL,
        # Now, not a fixed date. The hourly sweep deletes job directories older
        # than JOB_TTL_SECONDS, and it runs at startup: a fixture with a
        # hardcoded timestamp is reaped before the first test opens the page,
        # leaving a registry entry pointing at nothing.
        "created_at": time.time(),
        # Analysed with the current loudness method (LOUDNESS_VERSION in
        # app/core/models.py; not imported, for the reason _ffmpeg gives).
        # Without it, the first open measures the song again in the
        # background, and every later spec in the run sees the "measured
        # again" note under the cards (#923), depending on spec order.
        "loudness_version": 2,
        "bpm": 120,
        "key": "C maj",
        "scale": "Major",
        # Per-stem RMS as 0-100 ints, which is what drives the presence cards.
        "stem_presence": {name: 80 for name in STEMS},
        # Same shape the pipeline writes (runner.py): entries, not bare names.
        # A list of strings deserialises without error and then leaves the
        # studio with nothing to play.
        "stems": [{"name": name, "url": f"/api/jobs/{job_id}/stems/{name}.wav"} for name in STEMS],
    }


def _ffmpeg() -> str:
    """The ffmpeg the app would use: STEMDECK_FFMPEG, else the one on PATH.
    Not app.core.config: importing it here, outside the server's environment,
    would create the app's default folders in the repository."""
    return os.environ.get("STEMDECK_FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"


def _notation_notes() -> dict[str, tuple[str, list[dict]]]:
    """Each stem's transcriber and notes, as played: seconds from the start.
    Every note starts a little late and ends a little early, as a real
    transcription does, so the quantiser has something to snap."""

    def note(beat: float, beats: float, pitch: int, velocity: int = 90) -> dict:
        start = round(beat * 0.5 + 0.012, 4)
        return {
            "start": start,
            "end": round(start + beats * 0.5 - 0.04, 4),
            "pitch": pitch,
            "velocity": velocity,
        }

    # A tune in D minor, a quarter note per beat.
    tune = [62, 65, 69, 67, 65, 64, 62, 60, 62, 65, 69, 72]
    vocals = [note(i, 1, p) for i, p in enumerate(tune)]
    # A drop D riff: the low D (38) is below a standard guitar's sixth string.
    riff = [38, 45, 50, 38, 41, 43, 38, 45]
    guitar = [note(i, 1, p, 80) for i, p in enumerate(riff)]
    guitar += [note(8, 2, p, 80) for p in (38, 45, 50)]  # a D5 chord, held
    guitar += [note(10 + i * 0.5, 0.5, p, 80) for i, p in enumerate((57, 60, 62, 65))]
    bass = [note(i * 2, 2, p) for i, p in enumerate((38, 33, 31, 36, 38, 33))]
    drums = []
    for i in range(24):  # eighth notes: hats throughout, kick on 1 and 3, snare on 2 and 4
        drums.append(note(i / 2, 0.25, 42, 70))
        if i % 4 == 0:
            drums.append(note(i / 2, 0.25, 36, 110))
        elif i % 4 == 2:
            drums.append(note(i / 2, 0.25, 38, 100))
    return {
        "vocals": ("crepe", vocals),
        "guitar": ("mt3", guitar),
        "bass": ("crepe", bass),
        "drums": ("mt3", drums),
    }


def _add_transcription(jobs_dir: Path, job_id: str, seconds: int) -> dict:
    """Write each stem's notes under stems/transcription/ in the format the
    worker writes (app/core/transcription_files.py; not imported, for the
    reason _ffmpeg gives), and return the fields the registry record gains."""
    folder = jobs_dir / job_id / "stems" / "transcription"
    folder.mkdir(parents=True, exist_ok=True)
    outcomes = {}
    for stem, (transcriber, notes) in _notation_notes().items():
        (folder / f"{stem}.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "stem": stem,
                    "transcriber": transcriber,
                    "model": "e2e-fixture",
                    "duration": float(seconds),
                    "notes": notes,
                }
            ),
            encoding="utf-8",
        )
        outcomes[stem] = {
            "status": "done",
            "notes": len(notes),
            "code": None,
            "transcriber": transcriber,
        }
    return {
        "key": NOTATION_KEY,
        "scale": NOTATION_SCALE,
        "transcription": "done",
        "transcription_stems": outcomes,
    }


def _build_mp3_job(jobs_dir: Path) -> dict:
    """The fixture track's shape, stored as MP3 with the encoder settings the
    storage stage uses (app/pipeline/stem_storage.py): CBR libmp3lame with the
    LAME header that carries the encoder delay."""
    record = _build_job(jobs_dir, MP3_JOB_ID, MP3_TITLE, DURATION_SEC)
    stems_dir = jobs_dir / MP3_JOB_ID / "stems"
    for name in STEMS:
        wav = stems_dir / f"{name}.wav"
        mp3 = stems_dir / f"{name}.mp3"
        subprocess.run(
            [
                _ffmpeg(),
                "-nostdin",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(wav),
                "-c:a",
                "libmp3lame",
                "-b:a",
                f"{MP3_KBPS}k",
                "-write_xing",
                "1",
                str(mp3),
            ],
            check=True,
        )
        wav.unlink()
    record.update(
        source_url=MP3_SOURCE_URL,
        created_at=MP3_CREATED_AT,
        stem_format="mp3",
        stem_mp3_kbps=MP3_KBPS,
        stems=[{"name": n, "url": f"/api/jobs/{MP3_JOB_ID}/stems/{n}.mp3"} for n in STEMS],
    )
    record.update(_add_transcription(jobs_dir, MP3_JOB_ID, DURATION_SEC))
    return record


def seed(jobs_dir: Path) -> list[str]:
    records = [
        _build_job(jobs_dir, JOB_ID, TITLE, DURATION_SEC),
        _build_job(jobs_dir, SIBLING_JOB_ID, SIBLING_TITLE, SIBLING_DURATION_SEC),
        _build_mp3_job(jobs_dir),
    ]
    (jobs_dir / "registry.json").write_text(
        json.dumps({"version": 1, "jobs": records}, indent=2) + "\n", encoding="utf-8"
    )
    return [record["id"] for record in records]


if __name__ == "__main__":
    target = Path(sys.argv[1]).expanduser().resolve()
    target.mkdir(parents=True, exist_ok=True)
    for job_id in seed(target):
        print(job_id)
