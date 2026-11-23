"""Strings and frets for guitar and bass parts (app/pipeline/fingering.py).

Scenarios of "Every tab note has a string and fret that sound its pitch",
"Fingerings are playable", "Notes the instrument cannot play are not silently
dropped" and "A suggested tuning is offered" in the tablature spec
(openspec change add-alphatab-notation).
"""

from __future__ import annotations

import random
import time

import pytest

from app.core.config import TAB_DEFAULT_PRESET, TAB_MAX_FRET, TAB_SPAN_FRETS, TAB_STEMS, TAB_TUNINGS
from app.pipeline.fingering import (
    OUT_OF_RANGE,
    TOO_MANY_NOTES,
    assign,
    candidates,
    reasons,
    suggest_tuning,
)
from app.pipeline.quantize import QNote

GUITAR = TAB_TUNINGS["guitar"]["standard"]
BASS = TAB_TUNINGS["bass"]["standard"]


def _note(pitch: int, step: int, steps: int = 4) -> QNote:
    beat, part = divmod(step, 4)
    return QNote(
        pitch=pitch,
        velocity=90,
        step=step,
        steps=steps,
        bar=beat // 4 + 1,
        beat=beat % 4 + 1,
        part=part,
        start=step * 0.125,
        end=(step + steps) * 0.125,
    )


def _line(pitches, every: int = 4) -> list[QNote]:
    return [_note(p, i * every, every) for i, p in enumerate(pitches)]


def _sounds(placed, tuning, capo: int = 0) -> bool:
    """Open string + capo + fret is the note's pitch, for every placement."""
    return all(tuning[len(tuning) - p.string] + capo + p.fret == p.note.pitch for p in placed)


# --- Tuning presets (task 2.1) -------------------------------------------------


def test_standard_guitar_is_e_a_d_g_b_e():
    assert TAB_TUNINGS["guitar"]["standard"] == (40, 45, 50, 55, 59, 64)


def test_each_preset_has_its_string_count():
    counts = {
        "guitar": {
            "standard": 6,
            "drop_d": 6,
            "half_step_down": 6,
            "d_standard": 6,
            "open_g": 6,
            "dadgad": 6,
            "seven_string": 7,
        },
        "bass": {"standard": 4, "drop_d": 4, "five_string": 5, "half_step_down": 4},
    }
    assert set(TAB_TUNINGS) == set(TAB_STEMS) == set(counts)
    for stem, presets in counts.items():
        assert {name: len(t) for name, t in TAB_TUNINGS[stem].items()} == presets
        # Lowest string first, and the default is offered for every stem.
        assert all(list(t) == sorted(t) for t in TAB_TUNINGS[stem].values())
        assert TAB_DEFAULT_PRESET in TAB_TUNINGS[stem]


def test_the_named_alternatives_are_what_their_names_say():
    guitar, bass = TAB_TUNINGS["guitar"], TAB_TUNINGS["bass"]
    assert guitar["drop_d"] == (38, 45, 50, 55, 59, 64)
    assert guitar["half_step_down"] == tuple(p - 1 for p in guitar["standard"])
    assert guitar["d_standard"] == tuple(p - 2 for p in guitar["standard"])
    assert guitar["dadgad"] == (38, 45, 50, 55, 57, 62)
    assert bass["standard"] == (28, 33, 38, 43)
    assert bass["drop_d"] == (26, 33, 38, 43)
    assert bass["five_string"] == (23, 28, 33, 38, 43)
    assert bass["half_step_down"] == tuple(p - 1 for p in bass["standard"])


# --- Every tab note has a string and fret that sound its pitch -----------------


def test_single_note_sounds_its_pitch():
    # The E above middle C on a standard guitar: the open first string is one
    # answer, and the lowest position, so it is the one chosen.
    placed, unplaced = assign([_note(64, 0)], GUITAR)
    assert not unplaced
    (p,) = placed
    assert (p.string, p.fret) == (1, 0)
    assert _sounds(placed, GUITAR)


def test_a_chord_puts_each_note_on_its_own_string():
    chord = [_note(p, 0) for p in (52, 55, 59)]  # E3 G3 B3
    placed, unplaced = assign(chord, GUITAR)
    assert not unplaced
    assert len(placed) == 3
    assert len({p.string for p in placed}) == 3
    assert _sounds(placed, GUITAR)


def test_candidates_are_every_place_the_pitch_can_be_played():
    # Middle C on a standard guitar: B string fret 1, G 5, D 10, A 15, low E 20.
    assert candidates(60, GUITAR) == [(4, 1), (3, 5), (2, 10), (1, 15), (0, 20)]
    assert candidates(39, GUITAR) == []  # below the lowest string
    assert candidates(64 + TAB_MAX_FRET + 1, GUITAR) == []  # above the top fret


# --- Fingerings are playable ---------------------------------------------------


def test_a_stepwise_bass_line_stays_in_position_and_crosses_strings():
    # C2 D2 E2 F2 could run up the A string (3 5 7 8). A bassist stays put and
    # crosses to the D string instead.
    placed, unplaced = assign(_line([36, 38, 40, 41]), BASS)
    assert not unplaced
    frets = [p.fret for p in placed]
    assert max(frets) - min(frets) <= 4
    assert len({p.string for p in placed}) >= 2
    assert _sounds(placed, BASS)


def test_a_chord_spans_no_more_than_four_frets():
    # A C major barre shape and an open E major: both fit one hand.
    for pitches in ((48, 55, 60, 64, 67), (40, 47, 52, 56, 59, 64)):
        placed, unplaced = assign([_note(p, 0) for p in pitches], GUITAR)
        assert not unplaced
        fretted = [p.fret for p in placed if p.fret > 0]
        assert max(fretted) - min(fretted) < TAB_SPAN_FRETS
        assert len({p.string for p in placed}) == len(pitches)


def test_open_strings_do_not_count_toward_the_span():
    # Low open E under F#4 and A4. Those two share no string below the fifth
    # fret (second string 7, first string 5), so the chord is playable only
    # because the open sixth string is left out of the span.
    placed, unplaced = assign([_note(p, 0) for p in (40, 66, 69)], GUITAR)
    assert not unplaced
    assert _sounds(placed, GUITAR)
    assert sorted(p.fret for p in placed) == [0, 5, 7]


def test_the_lower_of_two_equal_positions_is_used():
    # A3 B3 C#4 sits as well around the second fret (G string 2 4, B string 2)
    # as around the fourteenth (A string 12 14 16). The low one wins.
    placed, _ = assign(_line([57, 59, 61]), GUITAR)
    assert max(p.fret for p in placed) <= 5


def test_the_hand_does_not_jump_back_and_forth():
    # A phrase high on the first string, where only one position reaches the
    # top notes: the notes in between that could also be played low stay up.
    placed, unplaced = assign(_line([81, 79, 76, 79, 81, 84]), GUITAR)
    assert not unplaced
    frets = [p.fret for p in placed]
    assert min(frets) >= 8
    assert max(frets) - min(frets) <= 8


def test_a_long_rest_lets_the_hand_move_for_free():
    # High phrase, then silence for two bars, then a low note that could also
    # be played near the old position. After the rest it goes to the nut.
    high = _line([81, 84, 81], every=2)
    later = _note(57, 6 + 32)  # A3: G string fret 2, or up at fret 12 or 17
    placed, _ = assign([*high, later], GUITAR)
    assert placed[-1].fret <= 2


# --- Capo ----------------------------------------------------------------------


def test_a_capo_shifts_the_frets_and_nothing_goes_below_it():
    capo = 2
    line = _line([42, 47, 54, 59, 66])  # F#2 is the open sixth string with a capo at 2
    placed, unplaced = assign(line, GUITAR, capo)
    assert not unplaced
    assert all(p.fret >= 0 for p in placed)
    assert _sounds(placed, GUITAR, capo)
    assert placed[0].fret == 0
    # The open low E is now below the capo: no string reaches it.
    placed, unplaced = assign([_note(40, 0)], GUITAR, capo)
    assert not placed
    assert [u.reason for u in unplaced] == [OUT_OF_RANGE]


# --- Notes the instrument cannot play are not silently dropped ------------------


def test_a_note_below_the_lowest_string_is_reported():
    # D1 is below the open fourth string of a four-string bass.
    notes = [_note(26, 0), _note(28, 4), _note(33, 8)]
    placed, unplaced = assign(notes, BASS)
    assert [p.note.pitch for p in placed] == [28, 33]
    assert [(u.note.pitch, u.reason) for u in unplaced] == [(26, OUT_OF_RANGE)]
    assert reasons(unplaced) == {OUT_OF_RANGE: 1}
    # And a five-string or a lower tuning is suggested.
    assert suggest_tuning(notes, "bass", BASS) in ("drop_d", "five_string")


def test_seven_notes_at_once_on_six_strings_places_six():
    seven = [_note(p, 0) for p in (40, 47, 52, 56, 59, 64, 68)]
    placed, unplaced = assign(seven, GUITAR)
    assert len(placed) == 6
    assert len({p.string for p in placed}) == 6
    assert [u.reason for u in unplaced] == [TOO_MANY_NOTES]
    assert _sounds(placed, GUITAR)
    # Every note is accounted for, once.
    assert sorted(n.pitch for n in seven) == sorted(
        [p.note.pitch for p in placed] + [u.note.pitch for u in unplaced]
    )


def test_a_chord_no_hand_can_hold_keeps_what_it_can():
    # F2 on the sixth string (fret 1) and E5 high on the first (fret 12):
    # eleven frets apart, and neither has another place within reach of the
    # other. One is kept, one is reported.
    placed, unplaced = assign([_note(41, 0), _note(76, 0), _note(77, 0)], GUITAR)
    assert len(placed) + len(unplaced) == 3
    assert unplaced and all(u.reason == TOO_MANY_NOTES for u in unplaced)
    fretted = [p.fret for p in placed if p.fret > 0]
    assert max(fretted) - min(fretted) < TAB_SPAN_FRETS


def test_nothing_in_is_nothing_out():
    assert assign([], GUITAR) == ([], [])
    assert suggest_tuning([], "guitar", GUITAR) is None


# --- A suggested tuning is offered (task 2.3) -----------------------------------


def test_notes_a_whole_step_below_standard_suggest_drop_d():
    riff = _line([38, 38, 45, 50, 38, 41, 43, 38])  # low Ds under a D5 riff
    _, unplaced = assign(riff, GUITAR)
    assert reasons(unplaced) == {OUT_OF_RANGE: 4}
    assert suggest_tuning(riff, "guitar", GUITAR) == "drop_d"
    # In drop D everything is placed and nothing more is suggested.
    placed, unplaced = assign(riff, TAB_TUNINGS["guitar"]["drop_d"])
    assert len(placed) == len(riff) and not unplaced
    assert suggest_tuning(riff, "guitar", TAB_TUNINGS["guitar"]["drop_d"]) is None


def test_a_stray_note_is_not_worth_a_suggestion():
    # One low D among forty notes is a transcription slip, not a tuning.
    line = _line([52 + (i % 5) for i in range(40)])
    line.append(_note(38, 200))
    assert suggest_tuning(line, "guitar", GUITAR) is None


def test_no_suggestion_when_no_preset_does_better():
    # Too high for any guitar tuning.
    assert suggest_tuning(_line([100, 101, 102]), "guitar", GUITAR) is None
    # A stem with no tunings on offer.
    assert suggest_tuning(_line([10, 11]), "piano", GUITAR) is None


# --- Property test (task 2.4) ---------------------------------------------------


@pytest.mark.parametrize("seed", range(20))
def test_random_playable_lines_are_placed_correctly(seed):
    """For random lines that fit the instrument, every placed note sounds its
    pitch (open + capo + fret) and no two notes sounding together share a
    string."""
    rng = random.Random(seed)
    stem = rng.choice(TAB_STEMS)
    tuning = TAB_TUNINGS[stem][rng.choice(list(TAB_TUNINGS[stem]))]
    capo = rng.choice([0, 0, 0, 1, 2, 3, 5])
    low, high = tuning[0] + capo, tuning[-1] + capo + 12
    notes: list[QNote] = []
    step = 0
    for _ in range(rng.randint(20, 80)):
        size = rng.choice([1, 1, 1, 1, 2, 3]) if stem == "guitar" else 1
        base = rng.randint(low, high)
        above = [base + i for i in (3, 4, 5, 7, 8, 9, 12) if base + i <= high]
        pitches = {base, *rng.sample(above, min(size - 1, len(above)))}
        length = rng.choice([1, 2, 2, 4])
        notes.extend(_note(p, step, length) for p in sorted(pitches))
        step += length + rng.choice([0, 0, 0, 2, 40])

    placed, unplaced = assign(notes, tuning, capo)
    assert len(placed) + len(unplaced) == len(notes)
    # Every note is in range, so nothing may be reported as out of it.
    assert all(u.reason == TOO_MANY_NOTES for u in unplaced)
    assert _sounds(placed, tuning, capo)
    assert all(1 <= p.string <= len(tuning) and 0 <= p.fret <= TAB_MAX_FRET for p in placed)
    by_step: dict[int, list] = {}
    for p in placed:
        by_step.setdefault(p.note.step, []).append(p)
    for together in by_step.values():
        assert len({p.string for p in together}) == len(together)
        fretted = [p.fret for p in together if p.fret > 0]
        if fretted:
            assert max(fretted) - min(fretted) < TAB_SPAN_FRETS
    # A single line is always playable: nothing is left out.
    if stem == "bass":
        assert not unplaced


# --- Speed (task 2.5) -----------------------------------------------------------


def test_a_two_thousand_note_guitar_part_is_fingered_in_under_two_seconds():
    rng = random.Random(7)
    notes: list[QNote] = []
    step = 0
    while len(notes) < 2000:
        base = rng.randint(40, 76)
        size = rng.choice([1, 1, 2, 3, 4, 6])
        pitches = sorted({base + i for i in rng.sample([0, 3, 4, 7, 9, 12, 15, 16, 19], size)})
        notes.extend(_note(min(p, 84), step, 2) for p in pitches)
        step += 2
    notes = notes[:2000]
    started = time.perf_counter()
    placed, unplaced = assign(notes, GUITAR)
    elapsed = time.perf_counter() - started
    assert len(placed) + len(unplaced) == 2000
    assert elapsed < 2.0, f"fingering took {elapsed:.2f}s"
