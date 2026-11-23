"""Grid steps to written note values (app/pipeline/note_values.py), the
helper the MusicXML and alphaTex writers share
(openspec change add-alphatab-notation, task 3.2).
"""

from __future__ import annotations

from fractions import Fraction

import pytest

from app.core.config import QUANTIZE_PARTS
from app.pipeline.note_values import NoteValue, chord_spans, drum_spans, split_steps, voice_spans
from app.pipeline.quantize import QNote


def _beats(value: NoteValue) -> Fraction:
    """A written value's length in beats (quarter notes)."""
    length = Fraction(4, value.denominator)
    if value.dots:
        length *= Fraction(3, 2)
    if value.tuplet:
        length *= Fraction(2, value.tuplet)
    return length


def _written(values) -> list[str]:
    names = {1: "whole", 2: "half", 4: "quarter", 8: "8th", 16: "16th", 32: "32nd"}
    return [
        ("dotted " if v.dots else "") + names[v.denominator] + (" triplet" if v.tuplet else "")
        for v in values
    ]


def _note(pitch: int, step: int, steps: int) -> QNote:
    return QNote(pitch, 90, step, steps, 1, 1, 0, 0.0, 0.0)


# --- split_steps ---------------------------------------------------------------


def test_five_sixteenths_is_a_quarter_tied_to_a_sixteenth():
    assert _written(split_steps(0, 5, 4)) == ["quarter", "16th"]


def test_plain_values_on_the_beat():
    assert _written(split_steps(0, 16, 4)) == ["whole"]
    assert _written(split_steps(0, 8, 4)) == ["half"]
    assert _written(split_steps(0, 4, 4)) == ["quarter"]
    assert _written(split_steps(0, 2, 4)) == ["8th"]
    assert _written(split_steps(0, 1, 4)) == ["16th"]


def test_dotted_values():
    assert _written(split_steps(0, 12, 4)) == ["dotted half"]  # a whole bar of 3/4
    assert _written(split_steps(0, 6, 4)) == ["dotted quarter"]
    assert _written(split_steps(0, 3, 4)) == ["dotted 8th"]


def test_a_note_off_the_beat_does_not_run_across_the_beat_line():
    # From the "and" of one for six sixteenths: an eighth to the beat line,
    # then a quarter. Not a dotted quarter hiding beat two.
    assert _written(split_steps(2, 6, 4)) == ["8th", "quarter"]
    # From the second sixteenth for three: a sixteenth, then an eighth.
    assert _written(split_steps(1, 3, 4)) == ["16th", "8th"]


def test_a_value_starts_on_its_own_grid():
    # Two beats from beat two: not a half note across the middle of the bar.
    assert _written(split_steps(4, 8, 4)) == ["quarter", "quarter"]
    # Two beats from beat three is a half note.
    assert _written(split_steps(8, 8, 4)) == ["half"]


def test_a_bar_longer_than_a_whole_note():
    assert _written(split_steps(0, 20, 4)) == ["whole", "quarter"]  # 5/4
    assert _written(split_steps(0, 28, 4)) == ["whole", "dotted half"]  # 7/4


def test_a_triplet_grid():
    assert _written(split_steps(0, 1, 3)) == ["8th triplet"]
    assert _written(split_steps(0, 2, 3)) == ["quarter triplet"]
    assert _written(split_steps(0, 3, 3)) == ["quarter"]  # a whole beat is plain
    assert _written(split_steps(1, 2, 3)) == ["quarter triplet"]
    # Across the beat line: the last triplet eighth, then the first of the next.
    assert _written(split_steps(2, 2, 3)) == ["8th triplet", "8th triplet"]
    assert _written(split_steps(0, 7, 3)) == ["half", "8th triplet"]


def test_a_sextuplet_grid():
    assert _written(split_steps(0, 1, 6)) == ["16th triplet"]
    assert _written(split_steps(0, 2, 6)) == ["8th triplet"]
    assert _written(split_steps(0, 3, 6)) == ["8th"]  # half a beat is plain
    assert _written(split_steps(3, 3, 6)) == ["8th"]
    assert _written(split_steps(0, 6, 6)) == ["quarter"]
    assert _written(split_steps(2, 2, 6)) == ["16th triplet", "16th triplet"]


def test_nothing_is_nothing():
    assert split_steps(0, 0, 4) == []
    assert split_steps(3, -1, 4) == []


@pytest.mark.parametrize("parts", QUANTIZE_PARTS)
def test_the_values_always_add_up(parts):
    """For every resolution, every start in a bar of seven beats and every
    length to the bar line: the values sum to the length, in steps and in
    beats, and each value starts where the one before it ended."""
    bar = 7 * parts
    for offset in range(bar):
        for steps in range(1, bar - offset + 1):
            values = split_steps(offset, steps, parts)
            assert sum(v.steps for v in values) == steps, (parts, offset, steps)
            assert sum(_beats(v) for v in values) == Fraction(steps, parts)
            for v in values:
                assert _beats(v) == Fraction(v.steps, parts)
                assert v.denominator in (1, 2, 4, 8, 16, 32)


@pytest.mark.parametrize("parts", (1, 2, 4, 8))
def test_only_a_note_that_starts_on_a_beat_crosses_a_beat_line(parts):
    bar = 4 * parts
    for offset in range(bar):
        for steps in range(1, bar - offset + 1):
            at = offset
            for v in split_steps(offset, steps, parts):
                if at % parts:
                    assert at // parts == (at + v.steps - 1) // parts
                at += v.steps


# --- grouping ------------------------------------------------------------------


def test_chord_spans_group_notes_that_start_and_end_together():
    notes = [_note(60, 0, 4), _note(64, 0, 4), _note(67, 0, 8), _note(72, 4, 2)]
    spans = chord_spans(notes)
    assert [(s, n, [m.pitch for m in ms]) for s, n, ms in spans] == [
        (0, 4, [60, 64]),
        (0, 8, [67]),
        (4, 2, [72]),
    ]


def test_voice_spans_never_overlap():
    # A held bass note under two melody notes: the chord is cut at the next onset.
    notes = [_note(40, 0, 16), _note(64, 0, 4), _note(67, 4, 4), _note(72, 12, 8)]
    spans = voice_spans(notes, total_steps=16)
    assert [(s, n, [m.pitch for m in ms]) for s, n, ms in spans] == [
        (0, 4, [40, 64]),
        (4, 4, [67]),  # ends where it ends: the gap to step 12 is a rest
        (12, 4, [72]),  # cut at the end of the song
    ]
    for (a, n, _), (b, _, _) in zip(spans, spans[1:], strict=False):
        assert a + n <= b


def test_voice_spans_use_the_longest_note_of_a_chord():
    spans = voice_spans([_note(60, 0, 2), _note(64, 0, 6)], total_steps=16)
    assert [(s, n) for s, n, _ in spans] == [(0, 6)]


def test_drum_spans_last_to_the_next_hit_or_the_end_of_the_beat():
    hits = [_note(36, 0, 1), _note(42, 0, 1), _note(42, 2, 1), _note(38, 4, 1), _note(42, 7, 1)]
    spans = drum_spans(hits, steps_per_beat=4)
    assert [(s, n, [m.pitch for m in ms]) for s, n, ms in spans] == [
        (0, 2, [36, 42]),  # to the next hit
        (2, 2, [42]),  # to the end of the beat
        (4, 3, [38]),  # to the next hit
        (7, 1, [42]),  # to the end of the beat
    ]
