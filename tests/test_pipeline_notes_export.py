"""The MIDI and MusicXML writers (app/pipeline/notes_midi.py,
app/pipeline/notes_musicxml.py): the scenarios of the notation-export spec
that do not need the HTTP layer.
"""

from __future__ import annotations

import io

import mido
import pytest

from app.pipeline.notes_midi import PPQ, as_played_midi, quantised_midi
from app.pipeline.notes_musicxml import musicxml_score
from app.pipeline.quantize import bars_of, grid_beats, quantize


def _note(start, end, pitch=60, velocity=90):
    return {"start": start, "end": end, "pitch": pitch, "velocity": velocity}


def _load(data: bytes) -> mido.MidiFile:
    return mido.MidiFile(file=io.BytesIO(data))


def _names(mid: mido.MidiFile) -> list[str]:
    return [next(m.name for m in t if m.type == "track_name") for t in mid.tracks]


def _note_ons(track) -> list[tuple[int, int, int]]:
    """(absolute tick, pitch, channel) of every note-on."""
    tick, out = 0, []
    for msg in track:
        tick += msg.time
        if msg.type == "note_on" and msg.velocity > 0:
            out.append((tick, msg.note, msg.channel))
    return out


def _seconds_at(mid: mido.MidiFile, tick: int) -> float:
    """Wall-clock time of ``tick`` under the file's tempo map."""
    tempos, at = [], 0
    for msg in mid.tracks[0]:
        at += msg.time
        if msg.type == "set_tempo":
            tempos.append((at, msg.tempo))
    seconds, last_tick, tempo = 0.0, 0, 500_000
    for at, value in tempos:
        if at >= tick:
            break
        seconds += (at - last_tick) * tempo / 1_000_000 / mid.ticks_per_beat
        last_tick, tempo = at, value
    return seconds + (tick - last_tick) * tempo / 1_000_000 / mid.ticks_per_beat


def _drifting_grid(n=41, start=0.37):
    beats = [start]
    for i in range(n - 1):
        beats.append(beats[-1] + 60.0 / (96 + 12 * i / (n - 2)))
    return {"beats": beats, "bars": [{"beat": 0, "beats_per_bar": 4}], "bpm": 102.0}


# -- MIDI, as played --------------------------------------------------------


def test_as_played_midi_has_a_named_track_per_stem_and_drums_on_channel_ten():
    parts = {
        "vocals": [_note(1.0, 1.5, 64)],
        "bass": [_note(0.5, 1.0, 40)],
        "drums": [_note(0.0, 0.1, 36), _note(0.5, 0.6, 38)],
    }
    mid = _load(as_played_midi(parts, title="Song"))
    assert _names(mid) == ["Song", "vocals", "bass", "drums"]
    drums = _note_ons(mid.tracks[3])
    assert {channel for _, _, channel in drums} == {9}
    others = _note_ons(mid.tracks[1]) + _note_ons(mid.tracks[2])
    assert all(channel != 9 for _, _, channel in others)
    assert len({channel for _, _, channel in others}) == 2


def test_as_played_midi_keeps_note_times_within_a_few_milliseconds():
    notes = [_note(0.1234, 0.9876, 60), _note(12.3456, 12.5001, 62), _note(200.0, 201.25, 64)]
    mid = _load(as_played_midi({"vocals": notes}))
    ons = _note_ons(mid.tracks[1])
    for (tick, pitch, _), note in zip(ons, notes, strict=True):
        assert pitch == note["pitch"]
        assert _seconds_at(mid, tick) == pytest.approx(note["start"], abs=0.005)
    assert mido.MidiFile(file=io.BytesIO(as_played_midi({"vocals": notes}))).length == (
        pytest.approx(201.25, abs=0.005)
    )


def test_a_repeated_pitch_is_released_before_it_is_struck_again():
    mid = _load(as_played_midi({"bass": [_note(0.0, 0.5, 40), _note(0.5, 1.0, 40)]}))
    kinds = [m.type for m in mid.tracks[1] if m.type in ("note_on", "note_off")]
    assert kinds == ["note_on", "note_off", "note_on", "note_off"]


def test_only_the_chosen_stems_are_written():
    mid = _load(as_played_midi({"bass": [_note(0, 1, 40)]}))
    assert _names(mid)[1:] == ["bass"]


# -- MIDI, quantised --------------------------------------------------------


def test_quantised_midi_puts_notes_on_exact_ticks():
    grid = _drifting_grid()
    beats = grid_beats(grid)
    notes = quantize([_note(t + 0.01, t + 0.2) for t in beats[:-1]], grid, 4, monophonic=True)
    mid = _load(quantised_midi({"bass": notes}, beats, bars_of(grid), 4))
    ticks = [tick for tick, _, _ in _note_ons(mid.tracks[1])]
    # One lead-in beat, then a note on every beat.
    assert ticks == [PPQ + i * PPQ for i in range(len(beats) - 1)]


def test_quantised_midi_bar_lines_fall_on_the_downbeats_of_the_audio():
    grid = _drifting_grid()
    beats = grid_beats(grid)
    bars = bars_of(grid)
    mid = _load(quantised_midi({"bass": []}, beats, bars, 4))
    for bar in bars:
        tick = PPQ + bar.start_beat * PPQ
        assert _seconds_at(mid, tick) == pytest.approx(beats[bar.start_beat], abs=0.001)
    # And the drift is real: a fixed tempo would be far off by the end.
    fixed = beats[0] + (len(beats) - 1) * (beats[1] - beats[0])
    assert abs(fixed - beats[-1]) > 0.5


def test_quantised_midi_carries_time_signatures_from_the_bars():
    grid = {
        "beats": [0.5 * i for i in range(1, 30)],
        "bars": [{"beat": 0, "beats_per_bar": 4}, {"beat": 8, "beats_per_bar": 3}],
    }
    beats = grid_beats(grid)
    mid = _load(quantised_midi({"bass": []}, beats, bars_of(grid), 4))
    tick, sigs = 0, []
    for msg in mid.tracks[0]:
        tick += msg.time
        if msg.type == "time_signature":
            sigs.append((tick, msg.numerator, msg.denominator))
    # The lead-in bar, then 4/4 at the first beat, then 3/4 at beat 8.
    assert sigs[0] == (0, 1, 4)
    assert (PPQ, 4, 4) in sigs
    assert (PPQ + 8 * PPQ, 3, 4) in sigs


def test_a_grid_that_starts_at_zero_has_no_lead_in():
    grid = {"beats": [0.5 * i for i in range(9)], "bars": [{"beat": 0, "beats_per_bar": 4}]}
    beats = grid_beats(grid)
    notes = quantize([_note(0.0, 0.4)], grid, 4)
    mid = _load(quantised_midi({"bass": notes}, beats, bars_of(grid), 4))
    assert _note_ons(mid.tracks[1])[0][0] == 0


def test_a_long_silence_before_the_first_beat_still_lines_up():
    grid = {"beats": [40.0 + 0.5 * i for i in range(9)], "bars": []}
    beats = grid_beats(grid)
    mid = _load(quantised_midi({"bass": []}, beats, bars_of(grid), 4))
    lead = next(m for m in mid.tracks[0] if m.type == "time_signature").numerator * PPQ
    assert _seconds_at(mid, lead) == pytest.approx(40.0, abs=0.001)


@pytest.mark.parametrize("parts", [1, 2, 3, 4, 6, 8])
def test_every_resolution_divides_the_midi_resolution(parts):
    grid = {"beats": [0.5 * i for i in range(9)], "bars": []}
    notes = quantize([_note(0.6, 0.9)], grid, parts)
    mid = _load(quantised_midi({"bass": notes}, grid_beats(grid), bars_of(grid), parts))
    assert _note_ons(mid.tracks[1])[0][0] % (PPQ // parts) == 0


# -- MusicXML ---------------------------------------------------------------


def _parse(xml: bytes):
    from music21 import converter

    return converter.parseData(xml.decode("utf-8"), format="musicxml")


def _grid_44(n=33):
    return {"beats": [0.5 * i for i in range(n)], "bars": [{"beat": 0, "beats_per_bar": 4}]}


def test_musicxml_has_a_part_per_stem_in_four_four_bars():
    grid = _grid_44()
    parts = {
        "vocals": quantize([_note(0.0, 1.0, 64), _note(2.0, 3.0, 67)], grid, 4, monophonic=True),
        "bass": quantize([_note(0.0, 0.5, 40), _note(1.0, 1.5, 43)], grid, 4, monophonic=True),
    }
    xml = musicxml_score(parts, bars_of(grid), 4, title="Blue in Green", bpm=120)
    score = _parse(xml)
    assert [p.partName for p in score.parts] == ["vocals", "bass"]
    for part in score.parts:
        measures = part.getElementsByClass("Measure")
        assert len(measures) == len(bars_of(grid))
        assert measures[0].timeSignature.ratioString == "4/4"
        assert all(m.barDuration.quarterLength == 4 for m in measures[:-1])
    assert b"Blue in Green" in xml
    assert b"<per-minute>120</per-minute>" in xml


def test_a_note_across_a_bar_line_is_tied():
    grid = _grid_44()
    # Starts on beat 4 of bar 1 and lasts two beats.
    notes = quantize([_note(1.5, 2.5, 60)], grid, 4)
    score = _parse(musicxml_score({"vocals": notes}, bars_of(grid), 4))
    tied = [n for n in score.parts[0].recurse().notes if n.tie is not None]
    assert [n.tie.type for n in tied] == ["start", "stop"]
    assert [n.measureNumber for n in tied] == [1, 2]
    assert sum(float(n.quarterLength) for n in tied) == 2.0


def test_a_meter_change_changes_the_time_signature_at_that_bar():
    grid = {
        "beats": [0.5 * i for i in range(21)],
        "bars": [{"beat": 0, "beats_per_bar": 4}, {"beat": 8, "beats_per_bar": 3}],
    }
    notes = quantize([_note(0.0, 0.5, 60), _note(4.0, 4.5, 62)], grid, 4)
    score = _parse(musicxml_score({"vocals": notes}, bars_of(grid), 4))
    measures = score.parts[0].getElementsByClass("Measure")
    assert measures[0].timeSignature.ratioString == "4/4"
    assert measures[2].timeSignature.ratioString == "3/4"
    assert measures[1].timeSignature is None


def test_bass_and_drums_get_their_clefs_and_drums_are_unpitched():
    grid = _grid_44()
    parts = {
        "bass": quantize([_note(0.0, 0.5, 40)], grid, 4, monophonic=True),
        "drums": quantize([_note(0.0, 0.1, 36), _note(0.0, 0.1, 42), _note(0.5, 0.6, 38)], grid, 4),
    }
    xml = musicxml_score(parts, bars_of(grid), 4)
    score = _parse(xml)
    clefs = [p.recurse().getElementsByClass("Clef")[0] for p in score.parts]
    assert clefs[0].sign == "F"
    assert clefs[1].sign == "percussion"
    assert xml.count(b"<unpitched>") == 3
    assert b">x</notehead>" in xml  # the hi-hat


def test_the_key_signature_comes_from_the_detected_key():
    grid = _grid_44()
    notes = quantize([_note(0.0, 0.5, 57)], grid, 4)
    xml = musicxml_score({"vocals": notes}, bars_of(grid), 4, key_name="F#", scale="minor")
    assert b"<fifths>3</fifths>" in xml
    plain = musicxml_score({"vocals": notes}, bars_of(grid), 4)
    assert b"<fifths>" not in plain
    odd = musicxml_score({"vocals": notes}, bars_of(grid), 4, key_name="??", scale="minor")
    assert b"<fifths>" not in odd
    # The job stores the key the way its chip shows it: "E maj", "G# min".
    e_major = musicxml_score({"vocals": notes}, bars_of(grid), 4, key_name="E maj", scale="Major")
    assert b"<fifths>4</fifths>" in e_major and b"<mode>major</mode>" in e_major
    g_sharp_minor = musicxml_score({"vocals": notes}, bars_of(grid), 4, key_name="G# min")
    assert b"<fifths>5</fifths>" in g_sharp_minor and b"<mode>minor</mode>" in g_sharp_minor
    b_flat = musicxml_score({"vocals": notes}, bars_of(grid), 4, key_name="Bb maj", scale="Major")
    assert b"<fifths>-2</fifths>" in b_flat


def test_every_part_has_the_same_bars_even_when_one_stops_early():
    grid = _grid_44()
    parts = {
        "vocals": quantize([_note(0.0, 0.5, 60)], grid, 4),
        "bass": quantize([_note(14.0, 14.5, 40)], grid, 4),
    }
    score = _parse(musicxml_score(parts, bars_of(grid), 4))
    counts = [len(p.getElementsByClass("Measure")) for p in score.parts]
    assert counts[0] == counts[1] == len(bars_of(grid))


def test_gaps_are_written_rests_not_hidden_ones():
    grid = _grid_44()
    notes = quantize([_note(1.0, 1.5, 60)], grid, 4)
    xml = musicxml_score({"vocals": notes}, bars_of(grid), 4)
    assert b"<rest" in xml
    assert b'print-object="no"' not in xml


def test_chords_and_overlapping_notes_survive_a_round_trip():
    grid = _grid_44()
    notes = quantize(
        [_note(0.0, 2.0, 48), _note(0.0, 2.0, 52), _note(0.0, 2.0, 55), _note(0.5, 1.0, 72)],
        grid,
        4,
    )
    score = _parse(musicxml_score({"piano": notes}, bars_of(grid), 4))
    pitches = sorted(p.midi for n in score.parts[0].recurse().notes for p in n.pitches)
    assert pitches == [48, 52, 55, 72]


def test_triplet_resolution_writes_tuplets():
    grid = _grid_44()
    third = 0.5 / 3
    notes = quantize([_note(i * third, (i + 1) * third, 60 + i) for i in range(3)], grid, 3)
    xml = musicxml_score({"vocals": notes}, bars_of(grid), 3)
    assert b"<time-modification>" in xml
    assert len(list(_parse(xml).parts[0].recurse().notes)) == 3
