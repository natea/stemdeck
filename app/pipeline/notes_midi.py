"""Write a song's transcription as a Standard MIDI File.

Two forms, one track per stem in both:

**As played.** Note times exactly as transcribed. The file runs at a fixed
120 BPM purely as a ruler (960 ticks per second), so it is a faithful timing
record, with no claim about where the bars are.

**Quantised.** Notes on the beat grid. One beat of the song is one quarter
note, and the file carries a tempo event at every beat, set from how long that
beat really lasted. So the notes sit on exact ticks and a DAW draws bar lines
where the song's bars are, and yet the file still plays in time with the
audio: tick N is reached at the moment the grid says. Time signatures come
from the grid's bars.

The audio rarely starts on beat 0. Whatever precedes the first beat becomes a
short lead-in bar at the head of the quantised file, as long as that
stretch really lasted, so everything after it stays aligned with the stems
when both start at zero. A DAW therefore shows the song's bar 1 as its bar 2.
"""

from __future__ import annotations

import io
import math
from collections.abc import Mapping, Sequence

import mido

from app.pipeline.quantize import Bar, QNote

PPQ = 480
# As-played files: 120 BPM at 480 PPQ is 960 ticks per second.
_AS_PLAYED_TEMPO = 500_000
_TICKS_PER_SECOND = 960
_DRUM_CHANNEL = 9
# General MIDI programs (zero-based), only so a DAW opens each track with a
# plausible sound. Anything unlisted is a piano.
_PROGRAMS: dict[str, int] = {
    "vocals": 52,  # choir aahs
    "lead_vocals": 52,
    "backing_vocals": 52,
    "bass": 33,  # electric bass (finger)
    "guitar": 25,  # acoustic guitar (steel)
    "piano": 0,
    "other": 48,  # string ensemble
}
# The shortest lead-in worth a bar of its own, and the longest a MIDI tempo
# event can express for one beat (a 24-bit count of microseconds).
_MIN_LEAD_S = 0.001
_MAX_TEMPO = 0xFFFFFF
_MAX_LEAD_BEAT_S = 16.0


def _channels(stems: Sequence[str]) -> dict[str, int]:
    """A channel per stem: drums on the percussion channel, the rest on the
    others in order, wrapping if there were ever more than fifteen."""
    out: dict[str, int] = {}
    free = [c for c in range(16) if c != _DRUM_CHANNEL]
    used = 0
    for stem in stems:
        if stem == "drums":
            out[stem] = _DRUM_CHANNEL
        else:
            out[stem] = free[used % len(free)]
            used += 1
    return out


def _track(name: str, channel: int, events: list[tuple[int, int, int, int]]) -> mido.MidiTrack:
    """A track from (tick, kind, pitch, velocity) events, kind 0 = off, 1 = on.
    Offs sort before ons at the same tick, so a repeated pitch re-attacks."""
    track = mido.MidiTrack()
    track.append(mido.MetaMessage("track_name", name=name, time=0))
    if channel != _DRUM_CHANNEL:
        track.append(
            mido.Message("program_change", channel=channel, program=_PROGRAMS.get(name, 0), time=0)
        )
    last = 0
    for tick, kind, pitch, velocity in sorted(events):
        msg = "note_on" if kind else "note_off"
        track.append(
            mido.Message(msg, channel=channel, note=pitch, velocity=velocity, time=tick - last)
        )
        last = tick
    track.append(mido.MetaMessage("end_of_track", time=0))
    return track


def _to_bytes(mid: mido.MidiFile) -> bytes:
    buf = io.BytesIO()
    mid.save(file=buf)
    return buf.getvalue()


def as_played_midi(parts: Mapping[str, Sequence[Mapping]], title: str = "") -> bytes:
    """A MIDI file of each stem's notes at the times they were transcribed.
    ``parts`` maps a stem name to its stored notes."""
    mid = mido.MidiFile(type=1, ticks_per_beat=PPQ)
    conductor = mido.MidiTrack()
    conductor.append(mido.MetaMessage("track_name", name=title or "StemDeck", time=0))
    conductor.append(mido.MetaMessage("set_tempo", tempo=_AS_PLAYED_TEMPO, time=0))
    conductor.append(mido.MetaMessage("end_of_track", time=0))
    mid.tracks.append(conductor)

    channels = _channels(list(parts))
    for stem, notes in parts.items():
        events: list[tuple[int, int, int, int]] = []
        for note in notes:
            on = max(0, round(float(note["start"]) * _TICKS_PER_SECOND))
            off = max(on + 1, round(float(note["end"]) * _TICKS_PER_SECOND))
            pitch = int(note["pitch"])
            events.append((on, 1, pitch, max(1, min(127, int(note.get("velocity", 80))))))
            events.append((off, 0, pitch, 0))
        mid.tracks.append(_track(stem, channels[stem], events))
    return _to_bytes(mid)


def _tempo(seconds: float) -> int:
    return max(1, min(_MAX_TEMPO, round(seconds * 1_000_000)))


def quantised_midi(
    parts: Mapping[str, Sequence[QNote]],
    beats: Sequence[float],
    bars: Sequence[Bar],
    steps_per_beat: int,
    title: str = "",
) -> bytes:
    """A MIDI file of each stem's quantised notes, with a tempo map and time
    signatures taken from the beat grid.

    ``beats`` are the grid's beat times, ``bars`` its bars
    (app/pipeline/quantize.bars_of), and ``steps_per_beat`` the resolution the
    notes were quantised at.
    """
    if PPQ % steps_per_beat:
        raise ValueError("steps per beat must divide the MIDI resolution")
    ticks_per_step = PPQ // steps_per_beat
    # One lead-in beat, or as many as it takes for each to fit a tempo event.
    lead_beats = max(1, math.ceil(beats[0] / _MAX_LEAD_BEAT_S)) if beats[0] >= _MIN_LEAD_S else 0
    lead = lead_beats * PPQ

    mid = mido.MidiFile(type=1, ticks_per_beat=PPQ)
    # (tick, order, message): time signatures before tempos at one tick.
    meta: list[tuple[int, int, mido.MetaMessage]] = []
    if lead:
        meta.append((0, 0, mido.MetaMessage("time_signature", numerator=lead_beats, denominator=4)))
        meta.append((0, 1, mido.MetaMessage("set_tempo", tempo=_tempo(beats[0] / lead_beats))))

    last_tempo: int | None = None
    for i in range(len(beats) - 1):
        tempo = _tempo(beats[i + 1] - beats[i])
        if tempo != last_tempo:
            meta.append((lead + i * PPQ, 1, mido.MetaMessage("set_tempo", tempo=tempo)))
            last_tempo = tempo

    last_sig: int | None = None
    for bar in bars:
        # A bar's own length is its signature: a pickup, or a bar cut short by
        # a meter change, is written as the short bar it is.
        if bar.beats != last_sig:
            meta.append(
                (
                    lead + bar.start_beat * PPQ,
                    0,
                    mido.MetaMessage("time_signature", numerator=bar.beats, denominator=4),
                )
            )
            last_sig = bar.beats

    conductor = mido.MidiTrack()
    conductor.append(mido.MetaMessage("track_name", name=title or "StemDeck", time=0))
    last = 0
    for tick, _order, msg in sorted(meta, key=lambda m: (m[0], m[1])):
        conductor.append(msg.copy(time=tick - last))
        last = tick
    conductor.append(mido.MetaMessage("end_of_track", time=0))
    mid.tracks.append(conductor)

    channels = _channels(list(parts))
    for stem, notes in parts.items():
        events: list[tuple[int, int, int, int]] = []
        for note in notes:
            on = lead + note.step * ticks_per_step
            off = on + max(1, note.steps) * ticks_per_step
            events.append((on, 1, note.pitch, note.velocity))
            events.append((off, 0, note.pitch, 0))
        mid.tracks.append(_track(stem, channels[stem], events))
    return _to_bytes(mid)
