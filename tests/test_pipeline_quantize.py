"""The beat-grid quantiser (app/pipeline/quantize.py).

Scenarios of "Notes are quantised to the song's beat grid" and "Transcription
works without a beat grid" in the stem-transcription spec.
"""

from __future__ import annotations

import random

import pytest

from app.pipeline.quantize import Bar, NoBeatGrid, bars_of, grid_beats, quantize, step_times


def _grid(bpm=120.0, n=33, start=0.0, bars=None):
    period = 60.0 / bpm
    return {
        "beats": [round(start + i * period, 6) for i in range(n)],
        "bars": [{"beat": 0, "beats_per_bar": 4}] if bars is None else bars,
    }


def _note(start, end, pitch=60, velocity=90):
    return {"start": start, "end": end, "pitch": pitch, "velocity": velocity}


def test_a_slightly_early_note_lands_on_the_beat():
    # 120 BPM: beat 3 of bar 1 is at 1.0 s. The note starts 30 ms early.
    (q,) = quantize([_note(0.97, 1.4)], _grid(), 4)
    assert (q.bar, q.beat, q.part) == (1, 3, 0)
    assert q.start == pytest.approx(1.0)


def test_sixteenths_snap_to_the_nearest_part():
    grid = _grid()
    starts = [0.0, 0.13, 0.26, 0.37]  # sixteenths at 120 BPM are 0.125 s apart
    q = quantize([_note(s, s + 0.1) for s in starts], grid, 4, monophonic=True)
    assert [(n.beat, n.part) for n in q] == [(1, 0), (1, 1), (1, 2), (1, 3)]
    assert all(n.steps == 1 for n in q)


def test_a_drifting_tempo_is_followed():
    # 100 -> 108 BPM over 32 beats: a fixed tempo would drift off the beat.
    beats = [0.0]
    for i in range(32):
        beats.append(beats[-1] + 60.0 / (100 + 8 * i / 31))
    grid = {"beats": beats, "bars": [{"beat": 0, "beats_per_bar": 4}]}
    notes = [_note(t, t + 0.2) for t in beats[:-1]]
    q = quantize(notes, grid, 4, monophonic=True)
    assert len(q) == 32
    assert all(n.part == 0 for n in q)
    assert [n.step for n in q] == [i * 4 for i in range(32)]
    assert [(n.bar, n.beat) for n in q[:5]] == [(1, 1), (1, 2), (1, 3), (1, 4), (2, 1)]


def test_a_note_that_collapses_to_one_point_is_one_step_long():
    (q,) = quantize([_note(1.0, 1.01)], _grid(), 4)
    assert q.steps == 1
    assert q.end > q.start


def test_resolution_is_chosen():
    grid = _grid()
    third = 0.5 / 3
    q = quantize([_note(third, third * 2), _note(third * 2, 0.5)], grid, 3, monophonic=True)
    assert [(n.beat, n.part) for n in q] == [(1, 1), (1, 2)]
    for parts in (1, 2, 3, 4, 6, 8):
        for n in quantize([_note(0.3, 0.9)], grid, parts):
            assert 0 <= n.part < parts
    with pytest.raises(ValueError):
        quantize([_note(0, 1)], grid, 5)


def test_edited_grid_changes_the_positions():
    notes = [_note(1.0, 1.4)]
    (before,) = quantize(notes, _grid(), 4)
    # The user moved every beat a quarter of a beat later.
    (after,) = quantize(notes, _grid(start=0.125), 4)
    assert (before.beat, before.part) == (3, 0)
    assert (after.beat, after.part) == (2, 3)


def test_no_beat_grid_is_refused():
    for grid in (None, {}, {"beats": []}, {"beats": [1.0]}, {"beats": "nope"}):
        with pytest.raises(NoBeatGrid):
            quantize([_note(0, 1)], grid, 4)


def test_beats_without_bar_marks_count_in_fours_from_the_first_beat():
    grid = _grid(bars=[])
    bars = bars_of(grid)
    assert bars[0] == Bar(1, 0, 4, 4)
    assert bars[1] == Bar(2, 4, 4, 4)
    (q,) = quantize([_note(2.5, 2.9)], grid, 4)  # beat index 5
    assert (q.bar, q.beat) == (2, 2)


def test_user_bar_marks_set_the_bar_length():
    grid = _grid(bars=[{"beat": 0, "beats_per_bar": 3}])
    (q,) = quantize([_note(1.5, 1.9)], grid, 4)  # beat index 3
    assert (q.bar, q.beat) == (2, 1)
    assert all(b.beats_per_bar == 3 for b in bars_of(grid))


def test_a_first_downbeat_after_beat_zero_leaves_a_pickup_bar():
    grid = _grid(n=13, bars=[{"beat": 2, "beats_per_bar": 4}])
    bars = bars_of(grid)
    assert bars[0] == Bar(1, 0, 2, 4)
    assert bars[1] == Bar(2, 2, 4, 4)
    assert sum(b.beats for b in bars) == 13


def test_a_first_mark_whole_bars_in_has_no_pickup():
    bars = bars_of(_grid(n=13, bars=[{"beat": 8, "beats_per_bar": 4}]))
    assert [b.start_beat for b in bars[:3]] == [0, 4, 8]
    assert bars[0].beats == 4


def test_a_meter_change_starts_a_new_bar_length():
    grid = _grid(n=21, bars=[{"beat": 0, "beats_per_bar": 4}, {"beat": 8, "beats_per_bar": 3}])
    bars = bars_of(grid)
    assert [(b.start_beat, b.beats, b.beats_per_bar) for b in bars[:4]] == [
        (0, 4, 4),
        (4, 4, 4),
        (8, 3, 3),
        (11, 3, 3),
    ]
    (q,) = quantize([_note(5.5, 5.9)], grid, 4)  # beat index 11
    assert (q.bar, q.beat) == (4, 1)


def test_malformed_bar_marks_are_ignored():
    grid = _grid(bars=[{"beat": "x"}, None, {"beat": 99999, "beats_per_bar": 4}, {"beat": 0}])
    assert bars_of(grid)[0].beats_per_bar == 4


def test_monophonic_notes_never_overlap():
    notes = [_note(0.0, 2.0, 40), _note(0.5, 0.9, 43), _note(1.0, 3.0, 45)]
    q = quantize(notes, _grid(), 4, monophonic=True)
    for a, b in zip(q, q[1:], strict=False):
        assert a.step + a.steps <= b.step
    assert [n.pitch for n in q] == [40, 43, 45]


def test_monophonic_keeps_the_louder_of_two_notes_on_one_step():
    q = quantize([_note(1.0, 1.4, 50, 40), _note(1.01, 1.4, 52, 100)], _grid(), 4, monophonic=True)
    assert [n.pitch for n in q] == [52]


def test_polyphonic_notes_keep_their_overlap_and_chords():
    notes = [_note(0.0, 2.0, 48), _note(0.0, 2.0, 52), _note(0.5, 1.0, 55)]
    q = quantize(notes, _grid(), 4)
    assert [(n.pitch, n.step, n.steps) for n in q] == [(48, 0, 16), (52, 0, 16), (55, 4, 4)]


def test_the_same_pitch_twice_on_one_step_is_one_note():
    q = quantize([_note(0.0, 0.5, 60), _note(0.01, 1.0, 60)], _grid(), 4)
    assert [(n.pitch, n.steps) for n in q] == [(60, 8)]


def test_notes_outside_the_grid_clamp_to_its_edges():
    grid = _grid(n=5, start=1.0)  # beats at 1.0 .. 3.0
    early, late = quantize([_note(0.2, 0.4), _note(9.0, 9.5)], grid, 4)
    assert early.step == 0
    assert late.step + late.steps == (5 - 1) * 4
    assert late.end == pytest.approx(3.0)


def test_unusable_notes_are_skipped():
    notes = [{"start": "x"}, _note(0.0, 0.5, 200), _note(float("nan"), 1.0), _note(0.5, 1.0)]
    assert len(quantize(notes, _grid(), 4)) == 1


def test_grid_beats_drops_what_is_not_strictly_increasing():
    assert grid_beats({"beats": [0.0, 0.5, 0.5, 0.4, 1.0, None, 1.5]}) == [0.0, 0.5, 1.0, 1.5]


def test_step_times_divides_each_real_interval():
    times = step_times([0.0, 1.0, 3.0], 2)
    assert times.tolist() == [0.0, 0.5, 1.0, 2.0, 3.0]


@pytest.mark.parametrize("parts", [2, 3, 4, 6, 8])
def test_jittered_notes_on_a_drifting_grid_quantise_back(parts):
    """Notes generated exactly on a drifting grid, then jittered by up to a
    third of a step, return to the positions they were generated at."""
    rng = random.Random(parts)
    beats = [0.3]
    for _ in range(48):
        beats.append(beats[-1] + 60.0 / rng.uniform(84, 132))
    grid = {"beats": beats, "bars": [{"beat": 0, "beats_per_bar": 4}]}
    times = step_times(beats, parts)

    steps = sorted(rng.sample(range(len(times) - 2), 60))
    notes, expected = [], []
    for step in steps:
        length = rng.randint(1, 3)
        end_step = min(step + length, len(times) - 1)
        width = min(times[step + 1] - times[step], times[end_step] - times[end_step - 1])
        jitter = width / 3
        notes.append(
            _note(
                times[step] + rng.uniform(-jitter, jitter),
                times[end_step] + rng.uniform(-jitter, jitter),
                pitch=40 + step % 40,
            )
        )
        expected.append((step, end_step - step))
    got = quantize(notes, grid, parts)
    assert sorted((n.step, n.steps) for n in got) == sorted(expected)
