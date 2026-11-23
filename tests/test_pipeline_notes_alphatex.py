"""The alphaTex writer (app/pipeline/notes_alphatex.py): the text for a small
fixture of each kind of stem, and for a meter change
(openspec change add-alphatab-notation, task 3.3).

The text asserted here is read by the real alphaTab in the browser tests
(tests/e2e/notation.spec.mjs), which is what proves it parses.
"""

from __future__ import annotations

import random
import re
from fractions import Fraction

import pytest

from app.core.config import QUANTIZE_PARTS, TAB_TUNINGS
from app.pipeline.fingering import assign
from app.pipeline.notes_alphatex import TabStaff, alphatex_score, key_of, sync_lines
from app.pipeline.quantize import QNote, bars_of

BASS = TAB_TUNINGS["bass"]["standard"]
GUITAR = TAB_TUNINGS["guitar"]["standard"]


def _q(pitch: int, step: int, steps: int) -> QNote:
    return QNote(pitch, 90, step, steps, 1, 1, 0, 0.0, 0.0)


def _grid(n: int = 9, bars=None) -> dict:
    """Beats every half second. Nine beats are two bars of 4/4 and the lone
    last beat, which is a bar of its own."""
    return {
        "beats": [round(0.5 * i, 3) for i in range(n)],
        "bars": bars or [{"beat": 0, "beats_per_bar": 4}],
    }


def _score(parts, grid=None, per_beat: int = 4, **kwargs) -> list[str]:
    grid = grid or _grid()
    beats = grid["beats"]
    text = alphatex_score(parts, bars_of(grid, len(beats)), beats, per_beat, **kwargs)
    assert text.endswith("\n")
    return text.splitlines()


def _tab(stem: str, notes, display: str = "both", preset: str = "standard", capo: int = 0):
    tuning = TAB_TUNINGS[stem][preset]
    placed, _ = assign(notes, tuning, capo)
    return {stem: TabStaff(tuning, capo, display, placed)}


SYNC = ["\\sync (0 0 0)", "\\sync (1 0 2000)", "\\sync (2 0 4000)", "\\sync (2 0 4500 1)"]


def test_a_sung_line_with_ties_and_rests():
    # A quarter, five sixteenths (a quarter tied to a sixteenth), a silence,
    # and a note held across the bar line.
    notes = [_q(60, 0, 4), _q(64, 4, 5), _q(67, 14, 4)]
    lines = _score({"vocals": notes}, title="Song", bpm=120, key_name="C maj", scale="Major")
    assert lines == [
        '\\title ("Song")',
        '\\subtitle ("Transcribed by StemDeck")',
        "\\tempo (120)",
        '\\track ("vocals" "vocals")',
        "\\staff {score} \\tuning (piano) \\instrument (52) \\displayTranspose (0)",
        "\\clef (G2) \\ks (cmajor) \\ts (4 4) C4.4 E4.4 E4{t}.16 r.16 r.8 r.8 G4.8 |",
        "G4{t}.8 r.8 r.4 r.2 |",
        "\\ts (1 4) r.4 |",
        *SYNC,
    ]


def test_piano_chords_in_a_flat_key():
    # A bass note held under the right hand is cut where the next chord
    # starts: one voice. Eb major spells its notes with flats.
    notes = [_q(48, 0, 16), _q(64, 0, 4), _q(67, 0, 4), _q(72, 4, 2), _q(70, 8, 8), _q(63, 8, 8)]
    lines = _score({"piano": notes}, key_name="Eb maj", scale="Major", bpm=96.4)
    assert lines[2] == "\\tempo (96)"
    assert lines[3:8] == [
        '\\track ("piano" "piano")',
        "\\staff {score} \\tuning (piano) \\instrument (0) \\displayTranspose (0)",
        "\\clef (G2) \\ks (ebmajor) \\ts (4 4) (C3 E4 G4).4 C5.8 r.8 (Eb4 Bb4).2 |",
        "r.1 |",
        "\\ts (1 4) r.4 |",
    ]


def test_drums_are_percussion_hits_that_last_to_the_next_hit_or_the_beat():
    hits = [(36, 0), (42, 0), (42, 2), (38, 4), (42, 4), (46, 7), (20, 8), (49, 12)]
    lines = _score({"drums": [_q(p, s, 1) for p, s in hits]})
    assert lines[3:8] == [
        '\\track ("drums" "drums")',
        "\\staff {score} \\instrument (percussion) \\displayTranspose (0)",
        # Kick and hat together, a snare for a dotted eighth up to the open
        # hat, and key 20 (outside the kit) drawn as a snare.
        "\\clef (neutral) \\ts (4 4) (36 42).8 (42).8 (38 42).8{d} (46).16 (38).4 (49).4 |",
        "r.1 |",
        "\\ts (1 4) r.4 |",
    ]


BASS_LINE = [_q(28, 0, 4), _q(31, 4, 4), _q(33, 8, 6), _q(36, 14, 4)]


def test_bass_as_staff_and_tab_together():
    lines = _score({"bass": BASS_LINE}, tabs=_tab("bass", BASS_LINE))
    assert lines[3:8] == [
        '\\track ("bass" "bass")',
        # Written an octave above where it sounds, as a bassist reads it.
        "\\staff {score tabs} \\tuning (G2 D2 A1 E1) \\instrument (33) \\displayTranspose (12)",
        "\\clef (F4) \\ts (4 4) 0.4.4 3.4.4 0.3.4{d} 3.3.8 |",
        "-.3.8 r.8 r.4 r.2 |",  # the tie across the bar line, on its string
        "\\ts (1 4) r.4 |",
    ]


def test_bass_as_tab_only():
    lines = _score({"bass": BASS_LINE}, tabs=_tab("bass", BASS_LINE, display="tab"))
    assert lines[4:6] == [
        "\\staff {tabs} \\tuning (G2 D2 A1 E1) \\instrument (33) \\displayTranspose (12)",
        "\\ts (4 4) 0.4.4 3.4.4 0.3.4{d} 3.3.8 |",
    ]


def test_bass_as_staff_only():
    lines = _score({"bass": BASS_LINE}, tabs=_tab("bass", BASS_LINE, display="score"))
    assert lines[4:7] == [
        "\\staff {score} \\tuning (piano) \\instrument (33) \\displayTranspose (12)",
        "\\clef (F4) \\ts (4 4) E1.4 G1.4 A1.4{d} C2.8 |",
        "C2{t}.8 r.8 r.4 r.2 |",
    ]


def test_a_stem_with_no_tab_choice_is_staff_notation():
    # A fretted stem the caller gave no tuning for is still drawn.
    lines = _score({"bass": BASS_LINE})
    assert lines[4].startswith("\\staff {score} \\tuning (piano)")


GUITAR_PART = [_q(40, 0, 4), _q(47, 0, 4), _q(52, 0, 4), _q(38, 4, 4), _q(64, 8, 8)]


def test_guitar_in_drop_d_is_one_staff_with_frets():
    tabs = _tab("guitar", GUITAR_PART, preset="drop_d")
    lines = _score({"guitar": GUITAR_PART}, tabs=tabs, key_name="E min", scale="Minor")
    assert lines[3:6] == [
        '\\track ("guitar" "guitar")',
        "\\staff {score tabs} \\tuning (E4 B3 G3 D3 A2 D2) \\instrument (27) \\displayTranspose (12)",
        "\\clef (G2) \\ks (eminor) \\ts (4 4) (2.4 2.5 2.6).4 0.6.4 0.1.2 |",
    ]
    assert not any(line.startswith("\\staff {tabs}") for line in lines)


def test_a_note_the_guitar_cannot_play_stays_on_the_staff_and_leaves_the_tab():
    # The low D is below a standard guitar. The staff keeps every note; the
    # tab staff, bar for bar beside it, has a rest where the D is.
    tabs = _tab("guitar", GUITAR_PART)
    lines = _score({"guitar": GUITAR_PART}, tabs=tabs, key_name="E min", scale="Minor")
    assert lines[3:12] == [
        '\\track ("guitar" "guitar")',
        "\\staff {score} \\tuning (piano) \\instrument (27) \\displayTranspose (12)",
        "\\clef (G2) \\ks (eminor) \\ts (4 4) (E2 B2 E3).4 D2.4 E4.2 |",
        "r.1 |",
        "\\ts (1 4) r.4 |",
        "\\staff {tabs} \\tuning (E4 B3 G3 D3 A2 E2) \\instrument (27) \\displayTranspose (12)",
        "(2.4 2.5 0.6).4 r.4 0.1.2 |",
        "r.1 |",
        "r.4 |",
    ]


def test_for_a_tab_editor_the_unplayable_note_is_left_out_and_the_track_is_one_staff():
    # The form a Guitar Pro file is made from: one staff per instrument.
    tabs = _tab("guitar", GUITAR_PART)
    grid = _grid()
    text = alphatex_score(
        {"guitar": GUITAR_PART},
        bars_of(grid, len(grid["beats"])),
        grid["beats"],
        4,
        tabs=tabs,
        split_unplaced=False,
    )
    lines = text.splitlines()
    assert [line for line in lines if line.startswith("\\staff")] == [
        "\\staff {score tabs} \\tuning (E4 B3 G3 D3 A2 E2) \\instrument (27) \\displayTranspose (12)"
    ]
    # The low D is a rest: there is no string to put it on.
    assert "\\clef (G2) \\ts (4 4) (2.4 2.5 0.6).4 r.4 0.1.2 |" in lines
    # With every note placed the two forms are the same text.
    placed = _tab("guitar", GUITAR_PART, preset="drop_d")
    args = ({"guitar": GUITAR_PART}, bars_of(grid, len(grid["beats"])), grid["beats"], 4)
    assert alphatex_score(*args, tabs=placed, split_unplaced=False) == alphatex_score(
        *args, tabs=placed
    )


def test_notes_left_off_the_tab_in_a_row_are_one_rest():
    # Four low Ds, a sixteenth each, below a standard guitar: a quarter rest
    # on the tab staff, not four sixteenth rests.
    notes = [_q(38, s, 1) for s in range(4)] + [_q(45, 4, 4)]
    lines = _score({"guitar": notes}, tabs=_tab("guitar", notes))
    tab_staff = next(i for i, line in enumerate(lines) if line.startswith("\\staff {tabs}"))
    assert lines[tab_staff + 1] == "r.4 0.5.4 r.2 |"
    # On the staff beside it every one of them is written.
    assert "\\clef (G2) \\ts (4 4) D2.16 D2.16 D2.16 D2.16 A2.4 r.2 |" in lines


def test_a_drum_hits_tail_joins_the_silence_after_it():
    # A hit on the second sixteenth lasts to the end of its beat; with the
    # empty beat after it that is one dotted quarter of silence... written as
    # the values a reader expects: to the beat line, then the beat.
    lines = _score({"drums": [_q(36, 1, 1)]})
    assert lines[5] == "\\clef (neutral) \\ts (4 4) r.16 (36).16 r.8 r.4 r.2 |"


def test_a_capo_is_named_and_frets_count_from_it():
    tabs = _tab("guitar", GUITAR_PART, capo=2)
    lines = _score({"guitar": GUITAR_PART}, tabs=tabs)
    tab_staff = lines.index(
        "\\staff {tabs} \\tuning (E4 B3 G3 D3 A2 E2) \\capo (2) \\instrument (27)"
        " \\displayTranspose (12)"
    )
    # The open E and the D are below the capo. B2 and E3 are now open strings.
    assert lines[tab_staff + 1] == "(0.4 0.5).4 r.4 3.2.2 |"


def test_a_meter_change_and_a_pickup_bar():
    # The first downbeat is the second beat, so the song opens with a pickup
    # of one beat. Four beats of 4/4, then 3/4.
    grid = _grid(12, [{"beat": 1, "beats_per_bar": 4}, {"beat": 5, "beats_per_bar": 3}])
    parts = {
        "vocals": [_q(62, 0, 4), _q(64, 4, 16), _q(65, 20, 12)],
        "bass": [_q(40, 4, 8)],
    }
    lines = _score(parts, grid)
    assert lines[3:] == [
        '\\track ("vocals" "vocals")',
        "\\staff {score} \\tuning (piano) \\instrument (52) \\displayTranspose (0)",
        "\\clef (G2) \\ts (1 4) D4.4 |",
        "\\ts (4 4) E4.1 |",
        "\\ts (3 4) F4.2{d} |",
        "r.2{d} |",
        "\\ts (1 4) r.4 |",
        # Only the first track carries the time signatures.
        '\\track ("bass" "bass")',
        "\\staff {score} \\tuning (piano) \\instrument (33) \\displayTranspose (12)",
        "\\clef (F4) r.4 |",
        "E2.2 r.2 |",
        "r.2{d} |",
        "r.2{d} |",
        "r.4 |",
        # One sync point per bar, at its first beat, and one at the end.
        "\\sync (0 0 0)",
        "\\sync (1 0 500)",
        "\\sync (2 0 2500)",
        "\\sync (3 0 4000)",
        "\\sync (4 0 5500)",
        "\\sync (4 0 6000 1)",
    ]


def test_a_triplet_grid():
    notes = [_q(60, 0, 1), _q(62, 1, 2), _q(64, 3, 3), _q(65, 8, 2)]
    lines = _score({"vocals": notes}, _grid(5), per_beat=3)
    assert lines[5] == (
        "\\clef (G2) \\ts (4 4) C4.8{tu 3} D4.4{tu 3} E4.4 r.4{tu 3}"
        " F4.8{tu 3} F4{t}.8{tu 3} r.4{tu 3} |"
    )


def test_sync_points_follow_a_tempo_that_drifts():
    # Beats that slow down: each bar's sync point is its own first beat.
    beats = [0.0, 0.5, 1.0, 1.5, 2.0, 2.6, 3.2, 3.8, 4.4]
    grid = {"beats": beats, "bars": [{"beat": 0, "beats_per_bar": 4}]}
    assert sync_lines(bars_of(grid, len(beats)), beats) == [
        "\\sync (0 0 0)",
        "\\sync (1 0 2000)",
        "\\sync (2 0 4400)",
        "\\sync (2 0 5000 1)",  # the last beat lasts as long as the one before
    ]


def test_the_title_cannot_break_out_of_its_quotes():
    lines = _score({"vocals": [_q(60, 0, 4)]}, title='A "quoted"\\ title\nsecond line')
    assert lines[0] == '\\title ("A \\"quoted\\"\\\\ title second line")'
    assert _score({"vocals": [_q(60, 0, 4)]})[0] == '\\title ("Transcription")'


def test_the_tempo_falls_back_to_the_spacing_of_the_beats():
    assert _score({"vocals": [_q(60, 0, 4)]})[2] == "\\tempo (120)"  # beats 0.5 s apart
    assert _score({"vocals": [_q(60, 0, 4)]}, bpm=999)[2] == "\\tempo (400)"


@pytest.mark.parametrize(
    ("key_name", "scale", "expected"),
    [
        ("C maj", "Major", (0, False)),
        ("G# min", "Minor", (8, True)),
        ("Bb maj", "Major", (10, False)),
        ("E♭ maj", None, (3, False)),
        ("A", "Harmonic Minor", (9, True)),
        ("", "Major", None),
        (None, None, None),
        ("H maj", None, None),
    ],
)
def test_key_of(key_name, scale, expected):
    assert key_of(key_name, scale) == expected


def test_a_key_alphatex_has_no_name_for_is_written_as_its_twin():
    # G# major is Ab major; Db minor is C# minor.
    assert "\\ks (abmajor)" in _score({"vocals": [_q(60, 0, 4)]}, key_name="G# maj")[5]
    assert "\\ks (c#minor)" in _score({"vocals": [_q(60, 0, 4)]}, key_name="Db min")[5]
    # Drums and tab-only staves carry no key signature.
    assert "\\ks" not in "\n".join(_score({"drums": [_q(36, 0, 1)]}, key_name="D maj"))


def test_notes_below_octave_zero_are_written_in_it():
    line = _score({"other": [_q(5, 0, 4), _q(127, 4, 4)]})[5]
    assert "F0.4 G9.4" in line


def _beats_in(line: str) -> Fraction:
    """The length, in beats, of the values written on one bar line."""
    # Chords and tag arguments are in parentheses, and hold dots and spaces of
    # their own: take them out first, so what is left is one word per value.
    flat = re.sub(r"\([^)]*\)", "X", line.replace("{tu 3}", "{tu3}"))
    total = Fraction(0)
    for word in flat.split():
        found = re.search(r"\.(\d+)((?:\{[^}]*\})*)$", word)
        if not found:
            continue
        value = Fraction(4, int(found.group(1)))
        if "{d}" in found.group(2):
            value *= Fraction(3, 2)
        if "{tu3}" in found.group(2):
            value *= Fraction(2, 3)
        total += value
    return total


def test_beats_in_reads_a_line():
    assert _beats_in("\\clef (G2) \\ts (4 4) C4.4 E4.4 E4{t}.16 r.16 r.8 r.8 G4.8 |") == 4
    assert _beats_in("(2.4 2.5 0.6).4 r.4 0.1.2 |") == 4
    assert _beats_in("C4.8{tu 3} D4.4{tu 3} E4.4{d} |") == Fraction(5, 2)


@pytest.mark.parametrize("per_beat", QUANTIZE_PARTS)
def test_every_bar_of_every_staff_is_exactly_full(per_beat):
    """Whatever the resolution, each bar line's values add up to its bar."""
    rng = random.Random(per_beat)
    grid = _grid(22, [{"beat": 2, "beats_per_bar": 4}, {"beat": 10, "beats_per_bar": 3}])
    total = 21 * per_beat
    notes = [
        _q(rng.randint(40, 70), s, rng.randint(1, 3 * per_beat))
        for s in sorted(rng.sample(range(total), min(30, total)))
    ]
    drums = [
        _q(rng.choice([36, 38, 42]), s, 1) for s in sorted(rng.sample(range(total), min(40, total)))
    ]
    lines = _score(
        {"vocals": notes, "guitar": notes, "drums": drums},
        grid,
        per_beat,
        tabs=_tab("guitar", notes),
    )
    bars = bars_of(grid, 22)
    staves: list[list[str]] = []
    for line in lines:
        if line.startswith("\\staff"):
            staves.append([])
        elif line.endswith("|"):
            staves[-1].append(line)
    assert len(staves) >= 3
    for staff in staves:
        assert len(staff) == len(bars)
        for bar, line in zip(bars, staff, strict=True):
            assert _beats_in(line) == bar.beats, (per_beat, line)
