"""Write a song's quantised transcription as a MusicXML score.

One part per stem, built from the quantiser's notes (app/pipeline/quantize.py)
and the beat grid's bars. One beat of the song is one quarter note, so a bar
of four beats is a bar of 4/4, and a bar the grid cut short (a pickup, or the
bar before a meter change) is written with the short signature it has.

music21 does the notation bookkeeping this needs and that is easy to get
wrong by hand: splitting a note at a bar line into tied notes, breaking a
five-sixteenth note into a quarter tied to a sixteenth, filling gaps with
rests, and putting notes that overlap with different lengths into voices.

The result is a correct starting point for a notation program, not an
engraving: no voice-leading choices, no enharmonic spelling beyond the key
signature.

music21 is slow to import, so it is imported inside the function. Nothing at
startup may import this module's dependency (tests/test_transcription_imports.py).
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from fractions import Fraction

from app.pipeline.quantize import Bar, QNote

# General MIDI percussion key -> (staff position as a treble-clef pitch,
# notehead). The usual drum-kit layout: kick in the bottom space, snare in the
# third space, cymbals on top with x heads.
_DRUM_DEFAULT = ("C5", "normal")
_DRUM_MAP: dict[int, tuple[str, str]] = {
    35: ("F4", "normal"),  # kick
    36: ("F4", "normal"),
    37: ("C5", "x"),  # side stick
    38: ("C5", "normal"),  # snare
    39: ("C5", "x"),  # clap
    40: ("C5", "normal"),
    41: ("A4", "normal"),  # floor toms
    43: ("A4", "normal"),
    45: ("D5", "normal"),  # mid toms
    47: ("D5", "normal"),
    48: ("E5", "normal"),  # high toms
    50: ("E5", "normal"),
    42: ("G5", "x"),  # closed hi-hat
    44: ("D4", "x"),  # pedal hi-hat
    46: ("G5", "x"),  # open hi-hat
    49: ("A5", "x"),  # crash
    57: ("A5", "x"),
    51: ("F5", "x"),  # ride
    59: ("F5", "x"),
    53: ("F5", "x"),  # ride bell
    52: ("B5", "x"),  # china
    55: ("B5", "x"),  # splash
    54: ("G5", "x"),  # tambourine
    56: ("E5", "x"),  # cowbell
}

_PITCH_CLASSES = ("C", "C#", "D", "E-", "E", "F", "F#", "G", "A-", "A", "B-", "B")


def _key(key_name: str | None, scale: str | None):
    """A music21 Key from the job's detected key, or None.

    The job keeps the key as the chip shows it ("E maj", "G# min") and the
    scale beside it ("Major", "Minor", "Harmonic Minor"), so the tonic is the
    first word and either field can say minor."""
    from music21 import key as m21key

    words = (key_name or "").replace("♯", "#").replace("♭", "b").split()
    if not words or words[0][0].upper() not in "ABCDEFG":
        return None
    tonic = words[0][0].upper() + words[0][1:].replace("b", "-")
    said = f"{' '.join(words[1:])} {scale or ''}".lower()
    mode = "minor" if "min" in said else "major"
    try:
        return m21key.Key(tonic, mode)
    except Exception:
        return None


def _clef(stem: str):
    from music21 import clef

    if stem == "drums":
        return clef.PercussionClef()
    if stem == "bass":
        # Bass sounds an octave below where it is written; the 8vb clef shows
        # the true pitches on the staff a bassist reads.
        return clef.Bass8vbClef()
    if stem == "guitar":
        return clef.Treble8vbClef()
    return clef.TrebleClef()


def _drum_events(
    notes: Sequence[QNote], unit: Fraction, steps_per_beat: int
) -> list[tuple[Fraction, object]]:
    """Drum hits have no length of their own. Each is written as lasting until
    the next hit or the end of its beat, whichever comes first, which is how a
    drum part is read (a hit on the beat is a quarter, not a sixteenth and
    three rests). Hits on the same step are one percussion chord."""
    from music21 import duration, note, percussion

    by_step: dict[int, list[QNote]] = defaultdict(list)
    for n in notes:
        by_step[n.step].append(n)
    out: list[tuple[Fraction, object]] = []
    steps = sorted(by_step)
    for i, step in enumerate(steps):
        beat_end = (step // steps_per_beat + 1) * steps_per_beat
        until = min(beat_end, steps[i + 1]) if i + 1 < len(steps) else beat_end
        hits = []
        seen: set[tuple[str, str]] = set()
        for n in sorted(by_step[step], key=lambda q: q.pitch):
            display, head = _DRUM_MAP.get(n.pitch, _DRUM_DEFAULT)
            if (display, head) in seen:
                continue
            seen.add((display, head))
            hit = note.Unpitched(displayName=display)
            hit.notehead = head
            hits.append(hit)
        element = hits[0] if len(hits) == 1 else percussion.PercussionChord(hits)
        element.duration = duration.Duration((until - step) * unit)
        out.append((step * unit, element))
    return out


def _pitched_events(notes: Sequence[QNote], unit: Fraction) -> list[tuple[Fraction, object]]:
    """Notes that start together and last equally long are one chord."""
    from music21 import chord, duration, note

    groups: dict[tuple[int, int], list[QNote]] = defaultdict(list)
    for n in notes:
        groups[(n.step, n.steps)].append(n)
    out: list[tuple[Fraction, object]] = []
    for (step, steps), members in sorted(groups.items()):
        pitches = sorted({m.pitch for m in members})
        element = note.Note(pitches[0]) if len(pitches) == 1 else chord.Chord(pitches)
        element.duration = duration.Duration(steps * unit)
        out.append((step * unit, element))
    return out


def musicxml_score(
    parts: Mapping[str, Sequence[QNote]],
    bars: Sequence[Bar],
    steps_per_beat: int,
    *,
    title: str = "",
    bpm: float | None = None,
    key_name: str | None = None,
    scale: str | None = None,
) -> bytes:
    """The score as MusicXML bytes. ``parts`` maps a stem name to its
    quantised notes, ``bars`` are the grid's bars, ``steps_per_beat`` the
    resolution the notes were quantised at."""
    from music21 import duration, metadata, meter, note, stream, tempo
    from music21.musicxml.m21ToXml import GeneralObjectExporter

    unit = Fraction(1, steps_per_beat)
    total_beats = sum(bar.beats for bar in bars)
    score = stream.Score()
    score.metadata = metadata.Metadata()
    score.metadata.title = title or "Transcription"
    score.metadata.composer = "Transcribed by StemDeck"
    key_signature = _key(key_name, scale)

    for index, (stem, notes) in enumerate(parts.items()):
        part = stream.Part()
        part.id = stem
        part.partName = stem
        part.insert(0, _clef(stem))
        if key_signature is not None and stem != "drums":
            part.insert(0, _key(key_name, scale))
        if index == 0 and bpm:
            part.insert(0, tempo.MetronomeMark(number=round(float(bpm))))

        # A time signature wherever the bar length changes. Bar lengths are the
        # grid's, so the measures music21 cuts are exactly the song's bars.
        last_len: int | None = None
        for bar in bars:
            if bar.beats != last_len:
                part.insert(bar.start_beat, meter.TimeSignature(f"{bar.beats}/4"))
                last_len = bar.beats

        if stem == "drums":
            events = _drum_events(notes, unit, steps_per_beat)
        else:
            events = _pitched_events(notes, unit)
        covered = Fraction(0)
        for offset, element in events:
            # A note that would run past the last bar ends with it.
            room = Fraction(total_beats) - offset
            if room <= 0:
                continue
            if element.duration.quarterLength > room:
                element.duration.quarterLength = room
            part.insert(offset, element)
            covered = max(covered, offset + element.duration.quarterLength)
        # Every part is as long as the song, so they all have the same bars:
        # a part that stops early ends in rests, not a shorter staff.
        if covered < total_beats:
            tail = note.Rest()
            tail.duration = duration.Duration(Fraction(total_beats) - covered)
            part.insert(covered, tail)
        # Gaps become written rests. Left to the exporter they are filled with
        # hidden ones, and a notation program then shows bars with holes.
        part.makeRests(fillGaps=True, inPlace=True, hideRests=False)
        score.insert(0, part)

    return GeneralObjectExporter(score).parse()
