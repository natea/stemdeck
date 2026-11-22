"""Turn a monophonic pitch curve into discrete notes.

A pitch tracker (CREPE, in app/pipeline/notes_adapters.py) answers one
question per 10 ms frame: what frequency is sounding, and how sure is it. A
melody is not that. A sung note wobbles around its pitch, slides into the next
one, and breaks for a consonant; a bass note is plucked twice at the same
pitch. This module is the step between the curve and the notes:

1. Voicing. A frame is part of a note only if the tracker is confident and the
   stem is loud enough there. Confidence has hysteresis, so a note starts on
   sure frames and survives a short dip.
2. Hz to fractional MIDI pitch, then a short median filter that removes
   single-frame octave jumps.
3. Segmentation. A note keeps a running median of its own pitch and ends when
   the curve leaves a band around it for long enough. Vibrato stays inside the
   band; a step to another pitch does not.
4. Re-attacks. A new attack inside a held pitch splits it, which is the only
   way two notes of the same pitch can be told apart.
5. Clean-up: merge fragments of one note, drop blips, round to a semitone,
   and take a velocity from loudness.

Everything here is a pure function of arrays, with no model and no audio I/O,
so each rule is tested on synthetic curves (tests/test_pipeline_pitch_notes.py).
The thresholds are named constants in app/core/config.py.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np

from app.core.config import (
    PITCH_MEDIAN_S,
    PITCH_MERGE_GAP_S,
    PITCH_MIN_NOTE_S,
    PITCH_ONSET_GUARD_S,
    PITCH_RMS_FLOOR_RATIO,
    PITCH_SPLIT_HOLD_S,
    PITCH_SPLIT_SEMITONES,
    PITCH_VOICED_ENTER,
    PITCH_VOICED_LEAVE,
)

# One note: {"start": s, "end": s, "pitch": MIDI int, "velocity": 1..127}.
Note = dict


def hz_to_midi(f0: np.ndarray) -> np.ndarray:
    """Fractional MIDI pitch per frame; NaN where the frequency is not positive."""
    f0 = np.asarray(f0, dtype=float)
    out = np.full(f0.shape, np.nan)
    ok = np.isfinite(f0) & (f0 > 0)
    out[ok] = 69.0 + 12.0 * np.log2(f0[ok] / 440.0)
    return out


def loud_level(rms: np.ndarray) -> float:
    """The stem's loud level: the 95th percentile of its non-silent frames.
    The reference both for the voicing floor and for velocity."""
    rms = np.asarray(rms, dtype=float)
    live = rms[rms > 0]
    return float(np.percentile(live, 95)) if live.size else 0.0


def voiced_mask(periodicity: np.ndarray, rms: np.ndarray, loud: float) -> np.ndarray:
    """Frames that belong to a note: confident (with hysteresis) and audible."""
    periodicity = np.asarray(periodicity, dtype=float)
    audible = np.asarray(rms, dtype=float) >= loud * PITCH_RMS_FLOOR_RATIO if loud > 0 else None
    out = np.zeros(periodicity.shape, dtype=bool)
    on = False
    for i, p in enumerate(periodicity):
        if audible is None or not audible[i] or not np.isfinite(p):
            on = False
        elif on:
            on = p >= PITCH_VOICED_LEAVE
        else:
            on = p >= PITCH_VOICED_ENTER
        out[i] = on
    return out


def _median_filter(midi: np.ndarray, voiced: np.ndarray, frames: int) -> np.ndarray:
    """Running median over voiced neighbours only, so the frames either side of
    a rest do not pull a note's edge toward silence."""
    if frames < 3:
        return midi
    half = frames // 2
    out = midi.copy()
    n = len(midi)
    for i in np.flatnonzero(voiced):
        a, b = max(0, i - half), min(n, i + half + 1)
        window = midi[a:b][voiced[a:b]]
        if window.size:
            out[i] = float(np.median(window))
    return out


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) frame ranges where ``mask`` is True."""
    if not mask.any():
        return []
    padded = np.concatenate(([False], mask, [False]))
    edges = np.flatnonzero(padded[1:] != padded[:-1])
    return list(zip(edges[::2].tolist(), edges[1::2].tolist(), strict=True))


def _split_by_pitch(midi: np.ndarray, start: int, end: int, hold: int) -> list[tuple[int, int]]:
    """Cut one voiced run into [start, end) notes wherever the pitch moves.

    The note's reference is the median of its own frames so far. A frame
    outside the band starts a count; ``hold`` such frames in a row end the
    note at the first of them. Coming back inside the band resets the count,
    which is what lets a wide vibrato or a scoop pass."""
    notes: list[tuple[int, int]] = []
    note_start = start
    away_from: int | None = None
    i = start
    while i < end:
        upto = i if away_from is None else away_from
        ref = float(np.median(midi[note_start : max(note_start + 1, upto)]))
        if abs(midi[i] - ref) > PITCH_SPLIT_SEMITONES:
            if away_from is None:
                away_from = i
            if i - away_from + 1 >= hold:
                if away_from > note_start:
                    notes.append((note_start, away_from))
                note_start = away_from
                away_from = None
                i = note_start
                # The new note's reference starts from its own first frame.
        else:
            away_from = None
        i += 1
    if end > note_start:
        notes.append((note_start, end))
    return notes


def _split_by_onsets(
    spans: list[tuple[int, int]], onset_frames: np.ndarray, guard: int, min_len: int
) -> list[tuple[int, int]]:
    """Cut a note at each attack that falls inside it, away from its edges."""
    if onset_frames.size == 0:
        return spans
    out: list[tuple[int, int]] = []
    for a, b in spans:
        cuts = [int(f) for f in onset_frames if a + max(guard, min_len) <= f <= b - min_len]
        last = a
        for cut in cuts:
            if cut - last >= min_len:
                out.append((last, cut))
                last = cut
        out.append((last, b))
    return out


def notes_from_pitch(
    f0: Sequence[float],
    periodicity: Sequence[float],
    rms: Sequence[float],
    hop_s: float,
    onsets: Sequence[float] = (),
) -> list[Note]:
    """Notes from a pitch curve.

    ``f0`` (Hz), ``periodicity`` (0..1 confidence) and ``rms`` (linear level)
    are one value per frame, ``hop_s`` seconds apart, frame 0 at time 0.
    ``onsets`` are attack times in seconds, from the stem's onset envelope.
    Returns notes in time order, never overlapping.
    """
    f0_arr = np.asarray(f0, dtype=float)
    n = len(f0_arr)
    if n == 0 or hop_s <= 0:
        return []
    per = np.asarray(periodicity, dtype=float)
    level = np.asarray(rms, dtype=float)
    if len(per) != n or len(level) != n:
        raise ValueError("f0, periodicity and rms must have one value per frame")

    loud = loud_level(level)
    midi = hz_to_midi(f0_arr)
    voiced = voiced_mask(per, level, loud) & np.isfinite(midi)
    if not voiced.any():
        return []
    midi = _median_filter(midi, voiced, max(1, round(PITCH_MEDIAN_S / hop_s)) | 1)

    hold = max(1, round(PITCH_SPLIT_HOLD_S / hop_s))
    min_len = max(1, round(PITCH_MIN_NOTE_S / hop_s))
    guard = max(1, round(PITCH_ONSET_GUARD_S / hop_s))
    merge_gap = max(0, round(PITCH_MERGE_GAP_S / hop_s))
    onset_frames = np.unique(np.round(np.asarray(onsets, dtype=float) / hop_s).astype(int))

    spans: list[tuple[int, int]] = []
    for a, b in _runs(voiced):
        spans.extend(_split_by_pitch(midi, a, b, hold))
    spans = _split_by_onsets(spans, onset_frames, guard, min_len)

    # (start, end, pitch) with the pitch a note rounds to.
    pitched = [(a, b, int(round(float(np.median(midi[a:b]))))) for a, b in spans if b > a]

    # Fragments of one note: the same pitch again after a gap too short to be
    # a rest, with no attack in between.
    merged: list[tuple[int, int, int]] = []
    for a, b, pitch in pitched:
        if merged:
            pa, pb, ppitch = merged[-1]
            attack_between = bool(
                onset_frames.size and np.any((onset_frames > pb - guard) & (onset_frames <= a))
            )
            split_here = a == pb and bool(onset_frames.size and np.any(onset_frames == a))
            if ppitch == pitch and a - pb <= merge_gap and not attack_between and not split_here:
                merged[-1] = (pa, b, pitch)
                continue
        merged.append((a, b, pitch))

    notes: list[Note] = []
    for a, b, pitch in merged:
        if b - a < min_len or not 0 <= pitch <= 127:
            continue
        gain = float(np.mean(level[a:b])) / loud if loud > 0 else 1.0
        velocity = int(np.clip(round(127 * min(1.0, gain) ** 0.5), 1, 127))
        notes.append(
            {
                "start": round(a * hop_s, 4),
                "end": round(b * hop_s, 4),
                "pitch": pitch,
                "velocity": velocity,
            }
        )
    return notes
