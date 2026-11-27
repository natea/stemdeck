"""Reading the chord detector's labels (app/pipeline/chord_labels.py).

Scenarios of "Every detected label becomes a chord or no chord" and "Detection
names chords from a large vocabulary" in the chord-recognition spec.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.chord_model import DEGREE_NAMES, degree_semitones, sort_degrees, split_degree
from app.pipeline import chord_labels
from app.pipeline.chord_labels import (
    NO_CHORD_LABELS,
    SHORTHANDS,
    entries_from_segments,
    has_chords,
    parse_label,
)

FIXTURE = Path(__file__).parent / "fixtures" / "chords" / "full_chord_list.txt"


def _vocabulary() -> list[str]:
    return [
        line.strip() for line in FIXTURE.read_text(encoding="utf-8").splitlines() if line.strip()
    ]


# --- Degrees ---------------------------------------------------------------


def test_degree_names_split_and_measure():
    assert split_degree("b7") == (7, -1)
    assert split_degree("#11") == (11, 1)
    assert split_degree("bb7") == (7, -2)
    assert split_degree("13") == (13, 0)
    assert split_degree("14") is None
    assert split_degree("x3") is None
    assert degree_semitones("1") == 0
    assert degree_semitones("b3") == 3
    assert degree_semitones("#11") == 6
    assert degree_semitones("b5") == 6  # the same key, another name
    assert degree_semitones("9") == 2
    assert degree_semitones("bb7") == 9
    assert "b13" in DEGREE_NAMES and "#9" in DEGREE_NAMES and "0" not in DEGREE_NAMES


def test_degrees_are_stored_in_one_order():
    assert sort_degrees(["b7", "5", "1", "3", "#11", "9"]) == ["1", "3", "5", "b7", "9", "#11"]
    # Flats before naturals before sharps on one number, each once.
    assert sort_degrees(["5", "#5", "b5", "5"]) == ["b5", "5", "#5"]


# --- A label is a chord ----------------------------------------------------


@pytest.mark.parametrize(
    ("label", "root", "degrees", "bass"),
    [
        ("C:maj", 0, ["1", "3", "5"], None),
        ("A:min7", 9, ["1", "b3", "5", "b7"], None),
        ("G:7", 7, ["1", "3", "5", "b7"], None),
        ("F#:maj/3", 6, ["1", "3", "5"], 10),
        ("Bb:maj7", 10, ["1", "3", "5", "7"], None),
        ("Eb:min", 3, ["1", "b3", "5"], None),
        ("B:hdim7", 11, ["1", "b3", "b5", "b7"], None),
        ("C:dim7", 0, ["1", "b3", "b5", "bb7"], None),
        ("D:minmaj7", 2, ["1", "b3", "5", "7"], None),
        ("C:13", 0, ["1", "3", "5", "b7", "9", "11", "13"], None),
        ("C:7/b7", 0, ["1", "3", "5", "b7"], 10),
        # A root alone is a major triad.
        ("C", 0, ["1", "3", "5"], None),
        # A bass note that is the root is no slash chord.
        ("C:maj/1", 0, ["1", "3", "5"], None),
    ],
)
def test_common_labels(label, root, degrees, bass):
    assert parse_label(label) == {"root": root, "degrees": degrees, "bass": bass}


def test_an_altered_dominant_keeps_its_alteration():
    # "Detection names chords from a large vocabulary": not a plain seventh.
    assert parse_label("A:7(b9)") == {
        "root": 9,
        "degrees": ["1", "3", "5", "b7", "b9"],
        "bass": None,
    }
    assert parse_label("G:7(#9)")["degrees"] == ["1", "3", "5", "b7", "#9"]
    assert parse_label("C:7(b13)")["degrees"] == ["1", "3", "5", "b7", "b13"]
    assert parse_label("F:maj7(#11)")["degrees"] == ["1", "3", "5", "7", "#11"]


def test_a_sixth_chord_is_a_sixth_chord():
    assert parse_label("C:maj6")["degrees"] == ["1", "3", "5", "6"]
    assert parse_label("A:min6")["degrees"] == ["1", "b3", "5", "6"]
    assert parse_label("C:maj6(9)")["degrees"] == ["1", "3", "5", "6", "9"]


def test_a_list_of_intervals_is_the_chord():
    # A root with only a fifth above it: a power chord.
    assert parse_label("C:(1,5)") == {"root": 0, "degrees": ["1", "5"], "bass": None}
    # The root is implied when the list leaves it out.
    assert parse_label("E:(b3,5)") == {"root": 4, "degrees": ["1", "b3", "5"], "bass": None}


def test_a_bare_root_is_a_chord_with_no_other_tones():
    assert parse_label("C:(1)") == {"root": 0, "degrees": ["1"], "bass": None}
    assert parse_label("D:1") == {"root": 2, "degrees": ["1"], "bass": None}


def test_omissions_remove_a_tone_of_the_shorthand():
    assert parse_label("C:maj(*3)")["degrees"] == ["1", "5"]
    assert parse_label("C:min7(*5,b6)")["degrees"] == ["1", "b3", "b6", "b7"]
    # A rootless voicing is still a chord on that root.
    assert parse_label("C:maj(*1)") == {"root": 0, "degrees": ["3", "5"], "bass": None}
    # Everything left out: the root stands.
    assert parse_label("C:(1,*1)")["degrees"] == ["1"]


def test_an_altered_fifth_takes_the_place_of_the_fifth():
    # "min7(b5)" is the half-diminished chord, not a minor seventh with both.
    assert parse_label("C:min7(b5)") == parse_label("C:hdim7")
    assert parse_label("C:9(b5)")["degrees"] == ["1", "3", "b5", "b7", "9"]
    assert parse_label("C:maj7(#5)")["degrees"] == ["1", "3", "#5", "7"]
    # The same as leaving the fifth out by hand.
    assert parse_label("C:7(b5)") == parse_label("C:7(b5,*5)")
    # The same in a bare list of intervals.
    assert parse_label("C:(1,5,b5)")["degrees"] == ["1", "b5"]
    # Nothing else is replaced: a flat ninth sits beside a ninth.
    assert parse_label("C:11(b9,b13)")["degrees"] == ["1", "3", "5", "b7", "b9", "9", "11", "b13"]


def test_the_bass_is_a_degree_above_the_root():
    assert parse_label("C:maj/5")["bass"] == 7
    assert parse_label("A:min7/b3")["bass"] == 0
    assert parse_label("F:7/6")["bass"] == 2
    assert parse_label("G:maj/#4")["bass"] == 1
    assert parse_label("C:maj/9")["bass"] == 2


@pytest.mark.parametrize(
    "label", ["N", "X", "", "   ", None, 7, "H:maj", "C:wat", "C:maj(", "C:maj/q"]
)
def test_no_chord(label):
    assert parse_label(label) is None


# --- The whole vocabulary --------------------------------------------------


def test_every_label_of_the_full_vocabulary_is_a_chord():
    labels = _vocabulary()
    # 380 chords written on C, and the detector's two labels that are no chord.
    assert len(labels) == 382
    assert labels.count("N") == 1 and labels.count("X") == 1
    chords = [label for label in labels if label not in NO_CHORD_LABELS]
    assert len(chords) == 380 and len(set(chords)) == 380
    for label in chords:
        assert label.startswith("C:"), label
        for root_name, root in (("C", 0), ("F#", 6)):
            chord = parse_label(root_name + label[1:])
            assert chord is not None, label
            assert chord["root"] == root
            assert chord["degrees"], label
            assert set(chord["degrees"]) <= DEGREE_NAMES
            assert chord["bass"] is None or 0 <= chord["bass"] <= 11
            assert chord["bass"] != root


def test_the_vocabulary_test_notices_a_missing_shorthand(monkeypatch):
    # The check above is only worth something if it can fail.
    monkeypatch.delitem(chord_labels.SHORTHANDS, "hdim7")
    assert parse_label("C:hdim7") is None
    assert any(
        parse_label(label) is None for label in _vocabulary() if label not in NO_CHORD_LABELS
    )


def test_every_shorthand_in_the_vocabulary_is_in_the_table():
    used = set()
    for label in _vocabulary():
        if label in NO_CHORD_LABELS:
            continue
        kind = label.partition("/")[0].partition(":")[2]
        name = kind.partition("(")[0]
        if name:
            used.add(name)
    assert used <= set(SHORTHANDS)


def test_the_fixture_is_the_vendored_packages_list():
    from app.pipeline import chord_engine

    vendored = chord_engine.VENDOR_DIR / "lv_chordia" / "data" / "full_chord_list.txt"
    assert vendored.read_text(encoding="utf-8") == FIXTURE.read_text(encoding="utf-8")


# --- The detector's output as a timeline -----------------------------------


def _seg(start, end, chord):
    return {"start_time": start, "end_time": end, "chord": chord}


def test_segments_become_entries_with_their_labels():
    entries = entries_from_segments([_seg(0.0, 2.5, "C:maj"), _seg(2.5, 5.0, "A:min7/b3")])
    assert entries == [
        {
            "start": 0.0,
            "end": 2.5,
            "root": 0,
            "degrees": ["1", "3", "5"],
            "bass": None,
            "label": "C:maj",
        },
        {
            "start": 2.5,
            "end": 5.0,
            "root": 9,
            "degrees": ["1", "b3", "5", "b7"],
            "bass": 0,
            "label": "A:min7/b3",
        },
    ]


def test_the_unknown_label_is_no_chord_and_keeps_its_label():
    (entry,) = entries_from_segments([_seg(0.0, 4.0, "X")])
    assert entry["root"] is None and entry["degrees"] == [] and entry["bass"] is None
    assert entry["label"] == "X"


def test_silence_at_the_start_is_a_no_chord_entry():
    entries = entries_from_segments([_seg(0.0, 2.6, "N"), _seg(2.6, 5.0, "C:7")])
    assert entries[0] == {
        "start": 0.0,
        "end": 2.6,
        "root": None,
        "degrees": [],
        "bass": None,
        "label": "N",
    }
    assert entries[1]["root"] == 0


def test_a_timeline_that_starts_late_is_filled_from_zero():
    entries = entries_from_segments([_seg(1.5, 3.0, "C:maj")], duration=6.0)
    assert [(e["start"], e["end"], e["root"]) for e in entries] == [
        (0.0, 1.5, None),
        (1.5, 3.0, 0),
        (3.0, 6.0, None),
    ]
    assert all("label" in e for e in entries)


def test_the_timeline_ends_with_the_song():
    # The detector's last frame runs a hundredth past the end of the audio.
    entries = entries_from_segments(
        [_seg(0.0, 3.0, "C:maj"), _seg(3.0, 6.01, "F:maj"), _seg(6.01, 6.5, "G:maj")], duration=6.0
    )
    assert [(e["start"], e["end"], e["root"]) for e in entries] == [(0.0, 3.0, 0), (3.0, 6.0, 5)]
    # With no duration known, the detector's own end stands.
    assert entries_from_segments([_seg(0.0, 6.01, "N")])[0]["end"] == 6.01


def test_neighbours_that_are_the_same_chord_are_joined():
    entries = entries_from_segments(
        [_seg(0.0, 1.0, "C:maj"), _seg(1.0, 2.0, "C:maj"), _seg(2.0, 3.0, "C:maj/3")]
    )
    assert [(e["start"], e["end"], e["bass"]) for e in entries] == [(0.0, 2.0, None), (2.0, 3.0, 4)]


def test_overlapping_and_unordered_segments_make_a_clean_timeline():
    entries = entries_from_segments(
        [
            _seg(2.0, 4.0, "G:7"),
            _seg(0.0, 2.5, "C:maj"),
            _seg(4.0, 4.0, "F:maj"),
            "junk",
            {"chord": "D:min"},
        ]
    )
    assert [(e["start"], e["end"], e["root"]) for e in entries] == [(0.0, 2.5, 0), (2.5, 4.0, 7)]
    for a, b in zip(entries, entries[1:], strict=False):
        assert a["end"] == b["start"]


def test_an_unreadable_label_is_no_chord_not_an_error(caplog):
    with caplog.at_level("WARNING", logger="stemdeck.chords"):
        entries = entries_from_segments(
            [_seg(0.0, 1.0, "C:nonsense"), _seg(1.0, 2.0, "C:nonsense2")]
        )
    # Two different unreadable labels: no chord over both, joined into one.
    assert [(e["start"], e["end"], e["root"]) for e in entries] == [(0.0, 2.0, None)]
    assert entries[0]["label"] == "C:nonsense"
    assert "not understood" in caplog.text


def test_has_chords():
    assert has_chords(entries_from_segments([_seg(0.0, 1.0, "C:maj")]))
    assert not has_chords(entries_from_segments([_seg(0.0, 9.0, "N")]))
    assert not has_chords([])


# --- The table the browser's symbol tests read -----------------------------


def test_the_symbol_fixture_holds_what_this_reader_makes_of_each_label():
    """tests/js/fixtures/chord-symbols.json pairs every chord label with its
    stored chord and the symbol the page writes for it (tests/js/chords.test.mjs
    pins the symbols). The stored chords in it are this module's reading: if
    the reader changes, the table has to be generated again."""
    import json

    fixture = Path(__file__).parent / "js" / "fixtures" / "chord-symbols.json"
    rows = json.loads(fixture.read_text(encoding="utf-8"))
    chords = [label for label in _vocabulary() if label not in NO_CHORD_LABELS]
    assert [row["label"] for row in rows] == chords
    for row in rows:
        assert parse_label(row["label"]) == {
            "root": row["root"],
            "degrees": row["degrees"],
            "bass": row["bass"],
        }, row["label"]
        assert row["symbol"] and row["slash"].startswith(row["symbol"])
