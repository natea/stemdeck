"""A song's chord files and the entry shape they hold (app/core/chord_files.py,
app/core/chord_model.py).

Scenarios of "The chord timeline is kept with the song" in the
chord-recognition spec.
"""

from __future__ import annotations

import json

import pytest

from app.core import chord_files
from app.core.chord_model import (
    MAX_ENTRIES,
    MAX_LABEL_CHARS,
    clean_entries,
    clean_entry,
    fill_gaps,
    same_chord,
)

C7_OVER_E = {
    "start": 2.6,
    "end": 5.1,
    "root": 0,
    "degrees": ["1", "3", "5", "b7"],
    "bass": 4,
    "label": "C:7/3",
}
SILENCE = {"start": 0.0, "end": 2.6, "root": None, "degrees": [], "bass": None, "label": "N"}


@pytest.fixture
def stems(tmp_path):
    # A folder of its own: conftest keeps a jobs root in tmp_path.
    folder = tmp_path / "song" / "stems"
    folder.mkdir(parents=True)
    return folder


def _detect(stems_dir, chords=None):
    return chord_files.write_detected(
        stems_dir,
        engine="lv-chordia",
        engine_version="1.1.0",
        vocabulary="full",
        duration=5.1,
        chords=[SILENCE, C7_OVER_E] if chords is None else chords,
    )


# --- The detected file -----------------------------------------------------


def test_a_detection_round_trips(stems):
    path = _detect(stems)
    assert path == stems / "chords.json"
    record = chord_files.read_detected(stems)
    assert record == {
        "version": 1,
        "engine": "lv-chordia",
        "engine_version": "1.1.0",
        "vocabulary": "full",
        "duration": 5.1,
        "chords": [SILENCE, C7_OVER_E],
    }


def test_no_temp_file_is_left_after_a_write(stems):
    _detect(stems)
    chord_files.write_user(stems, [C7_OVER_E])
    assert sorted(p.name for p in stems.iterdir()) == ["chords.json", "chords.user.json"]


def test_a_failed_write_leaves_the_earlier_file_and_no_temp(stems, monkeypatch):
    _detect(stems)
    before = (stems / "chords.json").read_bytes()

    def boom(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr(chord_files.os, "replace", boom)
    with pytest.raises(OSError):
        _detect(stems, [C7_OVER_E])
    assert (stems / "chords.json").read_bytes() == before
    assert [p.name for p in stems.iterdir()] == ["chords.json"]


def test_a_song_with_no_file_has_no_chords(stems):
    assert chord_files.read_detected(stems) is None
    assert chord_files.read_user(stems) is None
    assert not chord_files.has_chords(stems)


@pytest.mark.parametrize(
    "content",
    [
        "{not json",
        "[]",
        '{"chords": "nope"}',
        '{"chords": [{"start": 0, "end": 1, "root": 12, "degrees": ["1"]}]}',
        '{"chords": [{"start": 1, "end": 0, "root": 0, "degrees": ["1"]}]}',
        '{"chords": [{"start": 0, "end": 2, "root": 0, "degrees": ["1"]},'
        ' {"start": 1, "end": 3, "root": 5, "degrees": ["1"]}]}',
        b"\xff\xfe\x00",
    ],
)
def test_a_damaged_file_reads_as_absent(stems, content):
    path = stems / "chords.json"
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content, encoding="utf-8")
    assert chord_files.read_detected(stems) is None
    # It is still a file: the song can be detected again over it.
    assert chord_files.has_chords(stems)


def test_writing_refuses_a_timeline_that_is_not_valid(stems):
    with pytest.raises(ValueError):
        _detect(stems, [{**C7_OVER_E, "root": 40}])
    assert not (stems / "chords.json").exists()


# --- The user's corrections ------------------------------------------------


def test_corrections_are_a_second_file(stems):
    _detect(stems)
    corrected = {"start": 0.0, "end": 5.1, "root": 0, "degrees": ["1", "3", "5", "7"], "bass": None}
    chord_files.write_user(stems, [corrected])
    assert chord_files.read_user(stems) == [corrected]
    # The detection is as it was.
    assert chord_files.read_detected(stems)["chords"] == [SILENCE, C7_OVER_E]
    # A detection run again replaces only its own file.
    _detect(stems, [C7_OVER_E])
    assert chord_files.read_user(stems) == [corrected]


def test_corrections_never_hold_a_detector_label(stems):
    chord_files.write_user(stems, [C7_OVER_E])
    stored = json.loads((stems / "chords.user.json").read_text(encoding="utf-8"))
    assert "label" not in stored["chords"][0]
    assert stored["version"] == 1


def test_discarding_corrections_keeps_the_detection(stems):
    _detect(stems)
    chord_files.write_user(stems, [C7_OVER_E])
    assert chord_files.delete_user(stems) is True
    assert chord_files.read_user(stems) is None
    assert chord_files.read_detected(stems) is not None
    assert chord_files.delete_user(stems) is False


def test_unreadable_corrections_are_ignored(stems):
    _detect(stems)
    (stems / "chords.user.json").write_text("{", encoding="utf-8")
    assert chord_files.read_user(stems) is None
    assert chord_files.read_detected(stems) is not None


# --- The entry shape -------------------------------------------------------


def test_an_entry_is_put_in_the_stored_shape():
    entry = clean_entry(
        {"start": 1, "end": 2.00049, "root": 7, "degrees": ["b7", "1", "5", "3", "5"], "bass": 7},
        keep_label=False,
    )
    assert entry == {
        "start": 1.0,
        "end": 2.0,
        "root": 7,
        "degrees": ["1", "3", "5", "b7"],
        # A bass note that is the root is no slash chord.
        "bass": None,
    }


def test_no_chord_has_no_tones_and_no_bass():
    entry = clean_entry(
        {"start": 0, "end": 1, "root": None, "degrees": ["1"], "bass": 3}, keep_label=False
    )
    assert entry == {"start": 0.0, "end": 1.0, "root": None, "degrees": [], "bass": None}


def test_a_chord_with_no_degrees_is_its_root():
    assert clean_entry({"start": 0, "end": 1, "root": 2}, keep_label=False)["degrees"] == ["1"]


def test_a_label_is_kept_only_where_asked_and_is_bounded():
    raw = {**C7_OVER_E, "label": "x" * 500}
    assert len(clean_entry(raw, keep_label=True)["label"]) == MAX_LABEL_CHARS
    assert "label" not in clean_entry(raw, keep_label=False)
    assert "label" not in clean_entry({**C7_OVER_E, "label": 7}, keep_label=True)


@pytest.mark.parametrize(
    "raw",
    [
        "C7",
        None,
        {"start": 0, "end": 1, "root": 12, "degrees": ["1"]},
        {"start": 0, "end": 1, "root": -1, "degrees": ["1"]},
        {"start": 0, "end": 1, "root": True, "degrees": ["1"]},
        {"start": 0, "end": 1, "root": 1.5, "degrees": ["1"]},
        {"start": 0, "end": 1, "root": "C", "degrees": ["1"]},
        {"start": 0, "end": 1, "root": 0, "degrees": ["1"], "bass": 12},
        {"start": 0, "end": 1, "root": 0, "degrees": ["1", "14"]},
        {"start": 0, "end": 1, "root": 0, "degrees": ["h3"]},
        {"start": 0, "end": 1, "root": 0, "degrees": "1,3,5"},
        {"start": 0, "end": 1, "root": 0, "degrees": [3]},
        {"start": 1, "end": 1, "root": 0, "degrees": ["1"]},
        {"start": 2, "end": 1, "root": 0, "degrees": ["1"]},
        {"start": -1, "end": 1, "root": 0, "degrees": ["1"]},
        {"start": 0, "end": float("inf"), "root": 0, "degrees": ["1"]},
        {"start": 0, "end": float("nan"), "root": 0, "degrees": ["1"]},
        {"start": "0", "end": 1, "root": 0, "degrees": ["1"]},
        {"start": 0, "end": 90000, "root": 0, "degrees": ["1"]},
        {"end": 1, "root": 0, "degrees": ["1"]},
    ],
)
def test_an_entry_that_is_not_valid_is_refused(raw):
    with pytest.raises(ValueError):
        clean_entry(raw, keep_label=False)


def test_a_refusal_never_repeats_the_value_it_refused():
    secret = "launch-codes-1234"
    for raw in (
        {"start": 0, "end": 1, "root": secret, "degrees": ["1"]},
        {"start": 0, "end": 1, "root": 0, "degrees": [secret]},
        {"start": secret, "end": 1, "root": 0, "degrees": ["1"]},
    ):
        with pytest.raises(ValueError) as caught:
            clean_entry(raw, keep_label=False)
        assert secret not in str(caught.value)


def test_a_timeline_is_in_order_and_does_not_overlap():
    a = {"start": 0, "end": 2, "root": 0, "degrees": ["1"]}
    b = {"start": 2, "end": 4, "root": 5, "degrees": ["1"]}
    assert [e["root"] for e in clean_entries([a, b])] == [0, 5]
    with pytest.raises(ValueError):
        clean_entries([b, a])
    with pytest.raises(ValueError):
        clean_entries([a, {**b, "start": 1.5}])
    with pytest.raises(ValueError):
        clean_entries({"chords": []})
    assert clean_entries([]) == []


def test_a_timeline_has_a_size_limit():
    many = [
        {"start": i, "end": i + 1, "root": i % 12, "degrees": ["1"]} for i in range(MAX_ENTRIES + 1)
    ]
    assert len(clean_entries(many[:MAX_ENTRIES])) == MAX_ENTRIES
    with pytest.raises(ValueError):
        clean_entries(many)


def test_gaps_are_filled_with_no_chord():
    a = {"start": 1.0, "end": 2.0, "root": 0, "degrees": ["1"], "bass": None}
    b = {"start": 3.0, "end": 4.0, "root": 5, "degrees": ["1"], "bass": None}
    filled = fill_gaps([a, b], duration=6.0)
    assert [(e["start"], e["end"], e["root"]) for e in filled] == [
        (0.0, 1.0, None),
        (1.0, 2.0, 0),
        (2.0, 3.0, None),
        (3.0, 4.0, 5),
        (4.0, 6.0, None),
    ]
    # Nothing to add when it already covers everything, or no duration is known.
    assert fill_gaps(filled, duration=6.0) == filled
    assert fill_gaps([{**a, "start": 0.0}]) == [{**a, "start": 0.0}]
    assert fill_gaps([], duration=3.0) == [
        {"start": 0.0, "end": 3.0, "root": None, "degrees": [], "bass": None}
    ]


def test_same_chord_looks_at_root_tones_and_bass():
    c = {"root": 0, "degrees": ["1", "3", "5"], "bass": None}
    assert same_chord(c, {**c, "start": 9})
    assert not same_chord(c, {**c, "bass": 4})
    assert not same_chord(c, {**c, "degrees": ["1", "b3", "5"]})
    assert not same_chord(c, {**c, "root": 2})
    none = {"root": None, "degrees": [], "bass": None}
    assert same_chord(none, dict(none))
