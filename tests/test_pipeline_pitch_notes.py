"""The pitch-curve-to-notes step (app/pipeline/pitch_notes.py).

Synthetic curves only: every rule is a property of the arrays, so no model and
no audio is needed. The scenarios are those of "A pitch curve is turned into
discrete notes" in the stem-transcription spec.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.pipeline.pitch_notes import hz_to_midi, loud_level, notes_from_pitch, voiced_mask

HOP = 0.010


def _hz(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


class Curve:
    """Build f0 / periodicity / rms frame by frame."""

    def __init__(self) -> None:
        self.f0: list[float] = []
        self.per: list[float] = []
        self.rms: list[float] = []

    @property
    def now(self) -> float:
        return len(self.f0) * HOP

    def note(self, midi: float, seconds: float, *, vibrato: float = 0.0, level: float = 0.2):
        frames = round(seconds / HOP)
        for i in range(frames):
            wobble = vibrato * np.sin(2 * np.pi * 5.5 * i * HOP)
            self.f0.append(_hz(midi + wobble))
            self.per.append(0.9)
            self.rms.append(level)
        return self

    def rest(self, seconds: float, *, noisy: bool = False):
        for _ in range(round(seconds / HOP)):
            # A tracker still answers with some frequency in silence.
            self.f0.append(180.0)
            self.per.append(0.15 if noisy else 0.02)
            self.rms.append(0.004 if noisy else 0.0)
        return self

    def notes(self, onsets=()):
        return notes_from_pitch(self.f0, self.per, self.rms, HOP, onsets)


def test_hz_to_midi_is_exact_on_a440_and_nan_on_silence():
    out = hz_to_midi(np.array([440.0, 220.0, 0.0, -1.0]))
    assert out[0] == pytest.approx(69.0)
    assert out[1] == pytest.approx(57.0)
    assert np.isnan(out[2]) and np.isnan(out[3])


def test_held_note_with_vibrato_is_one_note():
    c = Curve().rest(0.2).note(60, 2.0, vibrato=0.45).rest(0.2)
    notes = c.notes()
    assert len(notes) == 1
    assert notes[0]["pitch"] == 60
    assert notes[0]["start"] == pytest.approx(0.2, abs=0.03)
    assert notes[0]["end"] - notes[0]["start"] == pytest.approx(2.0, abs=0.05)


def test_step_between_two_pitches_is_two_notes_with_the_boundary_at_the_change():
    c = Curve().note(57, 0.5).note(59, 0.5)
    notes = c.notes()
    assert [n["pitch"] for n in notes] == [57, 59]
    assert notes[0]["end"] == pytest.approx(0.5, abs=0.03)
    assert notes[1]["start"] == pytest.approx(0.5, abs=0.03)
    assert notes[0]["end"] <= notes[1]["start"]


def test_silence_and_breath_make_no_note():
    assert Curve().rest(1.0).notes() == []
    assert Curve().rest(1.0, noisy=True).notes() == []
    c = Curve().note(64, 0.4).rest(0.5, noisy=True).note(64, 0.4)
    notes = c.notes()
    assert len(notes) == 2
    assert notes[0]["end"] <= 0.45 and notes[1]["start"] >= 0.85


def test_repeated_note_with_a_new_attack_is_two_notes():
    c = Curve().note(40, 1.0)
    assert len(c.notes()) == 1
    notes = c.notes(onsets=[0.0, 0.5])
    assert [n["pitch"] for n in notes] == [40, 40]
    assert notes[0]["end"] == pytest.approx(0.5, abs=0.02)
    assert notes[1]["start"] == pytest.approx(0.5, abs=0.02)


def test_the_attack_that_starts_a_note_does_not_split_it():
    c = Curve().rest(0.3).note(45, 0.6)
    # The onset detector fires a little after the first voiced frame.
    assert len(c.notes(onsets=[0.32])) == 1


def test_a_blip_shorter_than_the_minimum_is_dropped():
    c = Curve().rest(0.2).note(70, 0.03).rest(0.2).note(62, 0.3)
    assert [n["pitch"] for n in c.notes()] == [62]


def test_a_single_frame_octave_jump_does_not_split_the_note():
    c = Curve().note(52, 0.6)
    c.f0[30] = _hz(64)
    notes = c.notes()
    assert len(notes) == 1 and notes[0]["pitch"] == 52


def test_a_short_dropout_inside_one_pitch_is_merged_back():
    c = Curve().note(55, 0.4).rest(0.02).note(55, 0.4)
    notes = c.notes()
    assert len(notes) == 1
    assert notes[0]["end"] - notes[0]["start"] == pytest.approx(0.82, abs=0.03)


def test_confidence_has_hysteresis():
    per = np.array([0.1, 0.55, 0.4, 0.4, 0.3, 0.4, 0.6])
    rms = np.full(per.shape, 0.2)
    mask = voiced_mask(per, rms, loud_level(rms))
    # Enters at 0.55, survives 0.4, leaves at 0.3, and 0.4 alone does not re-enter.
    assert mask.tolist() == [False, True, True, True, False, False, True]


def test_quiet_frames_are_unvoiced_however_confident():
    per = np.full(10, 0.95)
    rms = np.array([0.2] * 5 + [0.001] * 5)
    mask = voiced_mask(per, rms, loud_level(rms))
    assert mask.tolist() == [True] * 5 + [False] * 5


def test_velocity_follows_loudness():
    c = Curve().note(60, 0.4, level=0.2).rest(0.2).note(62, 0.4, level=0.02)
    loud, soft = c.notes()
    assert loud["velocity"] > soft["velocity"]
    assert 1 <= soft["velocity"] <= 127 and loud["velocity"] <= 127


def test_notes_never_overlap_and_are_in_time_order():
    c = Curve()
    for i, midi in enumerate([48, 50, 52, 53, 55, 53, 52, 50]):
        c.note(midi, 0.25, vibrato=0.2 if i % 2 else 0.0)
    notes = c.notes()
    assert [n["pitch"] for n in notes] == [48, 50, 52, 53, 55, 53, 52, 50]
    for a, b in zip(notes, notes[1:], strict=False):
        assert a["end"] <= b["start"]


def test_mismatched_lengths_are_refused():
    with pytest.raises(ValueError):
        notes_from_pitch([440.0, 440.0], [0.9], [0.2, 0.2], HOP)


def test_empty_input_gives_no_notes():
    assert notes_from_pitch([], [], [], HOP) == []


def test_synthesised_melody_recovers_pitches_and_onsets():
    """A short melody with vibrato and a gap, tracked exactly: the notes come
    back with the right pitches and with onsets within 50 ms (task 3.2)."""
    melody = [(57, 0.40), (60, 0.30), (None, 0.25), (62, 0.50), (62, 0.30), (59, 0.45)]
    c = Curve().rest(0.1)
    expected: list[tuple[int, float]] = []
    attacks: list[float] = []
    for midi, seconds in melody:
        if midi is None:
            c.rest(seconds)
            continue
        expected.append((midi, c.now))
        attacks.append(c.now)
        c.note(midi, seconds, vibrato=0.3)
    notes = c.notes(onsets=attacks)
    assert [n["pitch"] for n in notes] == [m for m, _ in expected]
    for note, (_, onset) in zip(notes, expected, strict=True):
        assert abs(note["start"] - onset) <= 0.05
