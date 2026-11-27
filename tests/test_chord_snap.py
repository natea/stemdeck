"""Putting chord changes on the beat (app/pipeline/chord_snap.py).

Scenarios of "Chord changes fall on beats" in the chord-recognition spec.
"""

from __future__ import annotations

import random

import pytest

from app.core.chord_model import clean_entries, fill_gaps
from app.pipeline.chord_snap import beat_position, nearest_beat, snap, usable_beats

C = {"root": 0, "degrees": ["1", "3", "5"], "bass": None}
F = {"root": 5, "degrees": ["1", "3", "5"], "bass": None}
G7 = {"root": 7, "degrees": ["1", "3", "5", "b7"], "bass": None}
AM = {"root": 9, "degrees": ["1", "b3", "5"], "bass": None}
NONE = {"root": None, "degrees": [], "bass": None}


def _beats(bpm=120.0, n=33, start=0.0):
    period = 60.0 / bpm
    return [round(start + i * period, 6) for i in range(n)]


def _line(*parts):
    """A timeline from (end, chord) pairs, starting at 0."""
    out, at = [], 0.0
    for end, chord in parts:
        out.append({"start": at, "end": end, **chord})
        at = end
    return out


def _shape(entries):
    return [(e["start"], e["end"], e["root"]) for e in entries]


def _covers(entries, start, end):
    assert entries[0]["start"] == pytest.approx(start)
    assert entries[-1]["end"] == pytest.approx(end)
    for a, b in zip(entries, entries[1:], strict=False):
        assert a["end"] == b["start"], "a gap or an overlap"
        assert b["end"] > b["start"]


# --- Helpers ---------------------------------------------------------------


def test_usable_beats():
    assert usable_beats({"beats": [1.0, 0.5, 1.5]}) == [0.5, 1.0, 1.5]
    assert usable_beats({"beats": [0.5]}) is None
    assert usable_beats({"beats": []}) is None
    assert usable_beats({}) is None
    assert usable_beats(None) is None
    assert usable_beats({"beats": [0.0, "x", float("nan"), True, 1.0]}) == [0.0, 1.0]


def test_nearest_beat_and_position():
    beats = _beats()  # every 0.5 s
    assert nearest_beat(beats, 0.92) == 1.0
    assert nearest_beat(beats, 0.7) == 0.5
    assert nearest_beat(beats, 0.75) == 0.5  # a tie goes to the earlier beat
    assert nearest_beat(beats, -3.0) == 0.0
    assert nearest_beat(beats, 99.0) == beats[-1]
    assert beat_position(beats, 1.25) == pytest.approx(2.5)
    assert beat_position(beats, -0.5) == pytest.approx(-1.0)
    assert beat_position(beats, beats[-1] + 1.0) == pytest.approx(len(beats) + 1)


# --- The scenarios ---------------------------------------------------------


def test_a_change_just_before_a_beat_lands_on_the_beat():
    # 120 BPM: a beat every 0.5 s. The change is 80 ms before the beat at 2.0.
    out = snap(_line((1.92, C), (8.0, F)), _beats())
    assert _shape(out) == [(0.0, 2.0, 0), (2.0, 8.0, 5)]


def test_a_chord_shorter_than_a_beat_is_not_in_the_timeline():
    # A third of a beat (0.167 s) of G7 between two long chords.
    out = snap(_line((4.1, C), (4.267, G7), (8.0, F)), _beats())
    assert [e["root"] for e in out] == [0, 5]
    _covers(out, 0.0, 8.0)
    # One boundary, on a beat next to where the short chord was.
    assert out[0]["end"] in (4.0, 4.5)


def test_a_short_chord_that_straddles_a_beat_is_not_stretched_to_a_whole_one():
    # 0.2 s around the middle between two beats: each edge alone would snap to
    # a different beat and turn a blip into a one-beat chord.
    out = snap(_line((2.2, C), (2.4, G7), (8.0, F)), _beats())
    assert [e["root"] for e in out] == [0, 5]


def test_a_run_of_flickers_settles_into_its_neighbours():
    out = snap(
        _line((4.0, C), (4.1, G7), (4.2, AM), (4.3, G7), (4.4, AM), (8.0, F)),
        _beats(),
    )
    assert [e["root"] for e in out] == [0, 5]
    _covers(out, 0.0, 8.0)


def test_a_chord_of_a_beat_or_more_is_kept():
    out = snap(_line((2.0, C), (2.5, G7), (8.0, F)), _beats())
    assert _shape(out) == [(0.0, 2.0, 0), (2.0, 2.5, 7), (2.5, 8.0, 5)]


def test_a_short_no_chord_between_two_chords_is_given_away_too():
    out = snap(_line((4.0, C), (4.1, NONE), (8.0, F)), _beats())
    assert [e["root"] for e in out] == [0, 5]


def test_equal_neighbours_are_joined():
    # The G7 blip goes, and the C on each side of it is one chord again.
    out = snap(_line((4.0, C), (4.15, G7), (8.0, C), (12.0, F)), _beats())
    assert _shape(out) == [(0.0, 8.0, 0), (8.0, 12.0, 5)]


def test_the_same_chord_over_another_bass_note_is_not_joined():
    over_e = {**C, "bass": 4}
    out = snap(_line((4.0, C), (8.0, over_e)), _beats())
    assert [(e["root"], e["bass"]) for e in out] == [(0, None), (0, 4)]


def test_the_ends_of_the_timeline_stay_where_they_are():
    # The song starts before the first beat and ends between two beats.
    beats = _beats(start=0.31)
    out = snap(_line((0.4, NONE), (4.27, C), (7.9, F)), beats)
    _covers(out, 0.0, 7.9)
    # The lead-in ends on the first beat.
    assert out[0]["root"] is None and out[0]["end"] == pytest.approx(0.31)


def test_a_lead_in_that_snaps_to_its_own_start_is_dropped():
    out = snap(_line((0.1, NONE), (4.0, C), (8.0, F)), _beats())
    assert _shape(out) == [(0.0, 4.0, 0), (4.0, 8.0, 5)]


def test_a_corrected_grid_moves_the_changes():
    line = _line((1.92, C), (8.0, F))
    assert snap(line, _beats())[0]["end"] == 2.0
    # The user moved every beat 0.2 s later: the nearest beat is now 1.7.
    assert snap(line, _beats(start=0.2))[0]["end"] == pytest.approx(1.7)


def test_no_grid_keeps_the_detectors_times():
    line = _line((1.92, C), (4.267, G7), (8.0, F))
    for beats in (None, [], [1.0]):
        out = snap(line, beats)
        assert out == line
        assert out is not line and out[0] is not line[0]


def test_the_input_is_not_changed():
    line = _line((1.92, C), (4.1, G7), (8.0, F))
    before = [dict(e) for e in line]
    snap(line, _beats())
    assert line == before


def test_an_empty_timeline():
    assert snap([], _beats()) == []


def test_a_single_entry_is_untouched():
    assert _shape(snap(_line((9.3, C)), _beats())) == [(0.0, 9.3, 0)]


def test_the_detectors_label_travels_with_its_entry():
    line = _line((1.92, C), (8.0, F))
    line[0]["label"], line[1]["label"] = "C:maj", "F:maj"
    assert [e["label"] for e in snap(line, _beats())] == ["C:maj", "F:maj"]


# --- A timeline the user placed by hand ------------------------------------


def test_min_beats_zero_merges_nothing_the_user_placed():
    # Two chords on one beat each, and a third that an edited grid squeezed.
    line = _line((2.0, C), (2.5, G7), (3.0, AM), (8.0, F))
    assert [e["root"] for e in snap(line, _beats(), 0)] == [0, 7, 9, 5]
    # A blip is not given away: it is moved to the grid like the rest.
    out = snap(_line((2.2, C), (2.4, G7), (8.0, F)), _beats(), 0)
    assert _shape(out) == [(0.0, 2.0, 0), (2.0, 2.5, 7), (2.5, 8.0, 5)]


def test_min_beats_zero_still_drops_what_has_no_length_left():
    out = snap(_line((2.02, C), (2.1, G7), (8.0, F)), _beats(), 0)
    assert [e["root"] for e in out] == [0, 5]


# --- Properties ------------------------------------------------------------


def _random_line(rng, duration):
    chords = [C, F, G7, AM, NONE]
    cuts = sorted({round(rng.uniform(0.05, duration - 0.05), 3) for _ in range(rng.randint(0, 40))})
    parts, last = [], None
    for end in [*cuts, duration]:
        chord = rng.choice([c for c in chords if c is not last])
        parts.append((end, chord))
        last = chord
    return _line(*parts)


@pytest.mark.parametrize("seed", range(40))
def test_the_result_covers_the_same_span_and_snapping_again_changes_nothing(seed):
    rng = random.Random(seed)
    duration = round(rng.uniform(4.0, 30.0), 3)
    # A grid that drifts, starts after zero and stops before the end.
    beats, at = [], rng.uniform(0.0, 0.6)
    while at < duration - rng.uniform(0.0, 1.0):
        beats.append(round(at, 6))
        at += rng.uniform(0.35, 0.7)
    line = _random_line(rng, duration)
    for min_beats in (1.0, 0):
        out = snap(line, beats, min_beats)
        _covers(out, 0.0, duration)
        on_beats = {round(b, 3) for b in beats}
        for entry in out[1:]:
            assert entry["start"] in on_beats
        for a, b in zip(out, out[1:], strict=False):
            assert (a["root"], a["degrees"], a["bass"]) != (b["root"], b["degrees"], b["bass"])
        # Still a valid stored timeline, and stable.
        assert clean_entries(out) == out
        assert fill_gaps(out) == out
        assert snap(out, beats, min_beats) == out
