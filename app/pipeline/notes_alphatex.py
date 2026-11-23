"""Write a song's quantised transcription as alphaTex, the text score format
of alphaTab, which draws StemDeck's Notation view
(openspec change add-alphatab-notation).

alphaTex says everything the view needs in one text: a track per stem, staff
notation or tablature or both for each, tunings and capo, the bars and time
signatures of the beat grid, notes as pitches or as fret and string, drums,
and a sync point per bar that pins the bar to its time in the song. The sync
points are what let the cursor follow StemDeck's own player through a tempo
that drifts.

Like the MusicXML writer (app/pipeline/notes_musicxml.py) this is a pure
function of the quantiser's notes and the grid's bars: nothing is stored, so
the score always shows the current grid and the current tuning. The two
writers share how notes are grouped and how a length becomes note values
(app/pipeline/note_values.py).

What the text looks like, as the alphaTab 1.9 parser reads it with no
warnings: every tag's arguments are in parentheses, a bar is one line ending
in ``|``, and the sync points come last.

    \\title ("Song")
    \\tempo (120)
    \\track ("bass" "bass")
    \\staff {score tabs} \\tuning (G2 D2 A1 E1) \\instrument (33) \\displayTranspose (12)
    \\clef (F4) \\ks (cmajor) \\ts (4 4) 3.4.4 5.4.4 2.3.4 3.3.4 |
    r.1 |
    \\sync (0 0 0)
    \\sync (1 0 2000)

One voice per staff. Notes that start together are a chord, and a chord ends
where the next one starts, so a note held under a moving line is shortened on
the page. The MIDI export keeps true lengths.

One beat of the song is one quarter note, as in the other exports.
"""

from __future__ import annotations

import statistics
from bisect import bisect_right
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from app.pipeline.fingering import Placed
from app.pipeline.note_values import NoteValue, Span, drum_spans, split_steps, voice_spans
from app.pipeline.quantize import Bar, QNote

# General MIDI programs (zero-based). The view is silent, so these only
# matter in the Guitar Pro file alphaTab exports from this score, where they
# pick the track's sound and icon. The same choices as the MIDI export
# (app/pipeline/notes_midi.py), except the guitar: a tab editor expects the
# clean electric.
_PROGRAMS: dict[str, int] = {
    "vocals": 52,
    "lead_vocals": 52,
    "backing_vocals": 52,
    "bass": 33,
    "guitar": 27,
    "piano": 0,
    "other": 48,
}
_SHARPS = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
_FLATS = ("C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B")
# The key names alphaTex knows, by tonic pitch class. A key it has no name for
# (G# major) is written as the key that sounds the same (Ab major).
_MAJOR = ("c", "db", "d", "eb", "e", "f", "f#", "g", "ab", "a", "bb", "b")
_MINOR = ("c", "c#", "d", "eb", "e", "f", "f#", "g", "g#", "a", "bb", "b")
_FLAT_KEYS = {
    ("db", False), ("eb", False), ("f", False), ("ab", False), ("bb", False),
    ("c", True), ("d", True), ("eb", True), ("f", True), ("g", True), ("bb", True),
}  # fmt: skip
_TONICS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
# alphaTab draws a drum by its "articulation" number, which for the standard
# kit is the General MIDI percussion key. A key outside the kit it knows is
# drawn as a snare rather than refused: alphaTab fails on an unknown number.
_DRUM_KEYS = range(35, 82)
_DRUM_FALLBACK = 38
_TEMPO_RANGE = (20, 400)


@dataclass(frozen=True)
class TabStaff:
    """How a fretted stem is drawn: its ``tuning`` (open-string pitches,
    lowest string first), ``capo``, ``display`` ("score", "tab" or "both") and
    the fingering of its notes (app/pipeline/fingering.py). A note with no
    place in ``placed`` is not on the tab staff."""

    tuning: Sequence[int]
    capo: int
    display: str
    placed: Sequence[Placed]


def _text(value: str) -> str:
    """A string argument: quoted, with what would end the string escaped and
    line breaks flattened."""
    flat = " ".join(str(value).split())[:200]
    return '"' + flat.replace("\\", "\\\\").replace('"', '\\"') + '"'


def key_of(key_name: str | None, scale: str | None) -> tuple[int, bool] | None:
    """(tonic pitch class, is minor) from the job's detected key, or None.

    The job keeps the key as the chip shows it ("E maj", "G# min") and the
    scale beside it ("Major", "Minor", "Harmonic Minor"), so the tonic is the
    first word and either field can say minor."""
    words = (key_name or "").replace("♯", "#").replace("♭", "b").split()
    if not words or words[0][0].upper() not in _TONICS:
        return None
    tonic = _TONICS[words[0][0].upper()]
    for mark in words[0][1:]:
        if mark == "#":
            tonic += 1
        elif mark == "b":
            tonic -= 1
        else:
            return None
    said = f"{' '.join(words[1:])} {scale or ''}".lower()
    return tonic % 12, "min" in said


def _key_tag(key: tuple[int, bool] | None) -> tuple[str | None, bool]:
    """The ``\\ks`` argument for a key, and whether its notes are spelt with flats."""
    if key is None:
        return None, False
    tonic, minor = key
    name = (_MINOR if minor else _MAJOR)[tonic]
    return f"{name}{'minor' if minor else 'major'}", (name, minor) in _FLAT_KEYS


def _pitch_name(pitch: int, flats: bool = False) -> str:
    """A pitch as alphaTex names it: middle C (60) is C4. alphaTex has no
    octave below 0, so anything under C0 (below the range of hearing, and of
    any transcriber) is written in octave 0."""
    while pitch < 12:
        pitch += 12
    return f"{(_FLATS if flats else _SHARPS)[pitch % 12]}{pitch // 12 - 1}"


def _suffix(value: NoteValue) -> str:
    out = f".{value.denominator}"
    if value.dots:
        out += "{d}"
    if value.tuplet:
        out += f"{{tu {value.tuplet}}}"
    return out


def _group(tokens: Sequence[str]) -> str:
    return tokens[0] if len(tokens) == 1 else f"({' '.join(tokens)})"


# A staff turns the notes of one span into alphaTex, or None for a rest.
# ``tied`` is true for every value of a span after its first.
Token = Callable[[list[QNote], bool], "str | None"]


def _pitched(flats: bool) -> Token:
    def token(members: list[QNote], tied: bool) -> str | None:
        names = [_pitch_name(p, flats) for p in sorted({m.pitch for m in members})]
        return _group([f"{n}{{t}}" if tied else n for n in names])

    return token


def _fretted(placed: Sequence[Placed]) -> Token:
    where = {(p.note.step, p.note.pitch): (p.string, p.fret) for p in placed}

    def token(members: list[QNote], tied: bool) -> str | None:
        spots = sorted({where[k] for m in members if (k := (m.step, m.pitch)) in where})
        if not spots:
            return None
        return _group([f"-.{string}" if tied else f"{fret}.{string}" for string, fret in spots])

    return token


def _drums(members: list[QNote], tied: bool) -> str | None:
    if tied:
        return None  # a hit does not ring on: the rest of its span is silence
    keys = sorted({m.pitch if m.pitch in _DRUM_KEYS else _DRUM_FALLBACK for m in members})
    # Always in parentheses: a bare "42.8" would read as fret 42 on string 8.
    return f"({' '.join(map(str, keys))})"


def _rests(offset: int, steps: int, per_beat: int) -> list[str]:
    return ["r" + _suffix(value) for value in split_steps(offset, steps, per_beat)]


def _bar_lines(
    spans: Sequence[Span], bars: Sequence[Bar], per_beat: int, token: Token
) -> list[str]:
    """One line of beats for every bar. A span that crosses a bar line is
    split there and tied over; the gaps are written as rests."""
    starts = [bar.start_beat * per_beat for bar in bars]
    sizes = [bar.beats * per_beat for bar in bars]
    segments: list[list[tuple[int, int, list[QNote], bool]]] = [[] for _ in bars]
    for step, length, members in spans:
        at, left, tied = step, length, False
        index = bisect_right(starts, at) - 1
        while left > 0 and 0 <= index < len(bars):
            take = min(left, starts[index] + sizes[index] - at)
            if take <= 0:
                break
            segments[index].append((at - starts[index], take, members, tied))
            at += take
            left -= take
            tied = True
            index += 1

    lines: list[str] = []
    for index, size in enumerate(sizes):
        beats: list[str] = []
        # Silence is gathered and written once a note ends it, so a gap, a
        # drum hit's tail and a note left off the tab that follow each other
        # are one rest and not three.
        silent_from = 0  # everything from here to the next note is silence
        for offset, take, members, tied in segments[index]:
            at = offset
            for count, value in enumerate(split_steps(offset, take, per_beat)):
                text = token(members, tied or count > 0)
                if text is not None:
                    beats.extend(_rests(silent_from, at - silent_from, per_beat))
                    beats.append(text + _suffix(value))
                    silent_from = at + value.steps
                at += value.steps
        beats.extend(_rests(silent_from, size - silent_from, per_beat))
        lines.append(" ".join(beats) + " |")
    return lines


def _tuning_tag(tuning: Sequence[int]) -> str:
    """alphaTex lists the strings from the highest down."""
    return "(" + " ".join(_pitch_name(p) for p in reversed(list(tuning))) + ")"


def _track(
    stem: str,
    notes: Sequence[QNote],
    bars: Sequence[Bar],
    per_beat: int,
    key: tuple[int, bool] | None,
    tab: TabStaff | None,
    meter: bool,
    split_unplaced: bool = True,
) -> list[str]:
    """The lines of one stem's track: its staves, each followed by its bars.
    ``meter`` is true for the first track, which carries the time signatures
    for the whole score. ``split_unplaced`` is what happens to a fretted stem
    shown as staff and tab when some of its notes have no string and fret:
    true gives them a staff of their own beside the tab, false leaves them
    out and keeps the track to one staff."""
    total = sum(bar.beats for bar in bars) * per_beat
    key_name, flats = _key_tag(key)
    program = _PROGRAMS.get(stem, 0)
    # Guitar and bass are written an octave above where they sound.
    octave_up = stem in ("guitar", "bass")
    clef = "F4" if stem == "bass" else "G2"

    # (staff line, tags before the first bar, the spans, how to write them)
    staves: list[tuple[str, list[str], Sequence[Span], Token]] = []
    if stem == "drums":
        head = "\\staff {score} \\instrument (percussion) \\displayTranspose (0)"
        staves.append((head, ["\\clef (neutral)"], drum_spans(notes, per_beat), _drums))
    else:
        spans = voice_spans(notes, total)
        first = [f"\\clef ({clef})"] + ([f"\\ks ({key_name})"] if key_name else [])
        transpose = f"\\displayTranspose ({12 if octave_up else 0})"
        score_head = f"\\staff {{score}} \\tuning (piano) \\instrument ({program}) {transpose}"
        if tab is None or tab.display == "score":
            staves.append((score_head, first, spans, _pitched(flats)))
        else:
            every_note_placed = len({(n.step, n.pitch) for n in notes}) == len(
                {(p.note.step, p.note.pitch) for p in tab.placed}
            )
            strings = f"\\tuning {_tuning_tag(tab.tuning)}"
            if tab.capo:
                strings += f" \\capo ({tab.capo})"
            strings += f" \\instrument ({program}) {transpose}"
            fretted = _fretted(tab.placed)
            if tab.display == "tab":
                staves.append((f"\\staff {{tabs}} {strings}", [], spans, fretted))
            elif every_note_placed or not split_unplaced:
                staves.append((f"\\staff {{score tabs}} {strings}", first, spans, fretted))
            else:
                # A note the instrument cannot play stays on the staff and is
                # absent from the tab, so the two are separate staves here.
                staves.append((score_head, first, spans, _pitched(flats)))
                staves.append((f"\\staff {{tabs}} {strings}", [], spans, fretted))

    lines = [f"\\track ({_text(stem)} {_text(stem)})"]
    for number, (head, first, spans, token) in enumerate(staves):
        lines.append(head)
        bar_lines = _bar_lines(spans, bars, per_beat, token)
        beats_in_bar: int | None = None
        for index, bar in enumerate(bars):
            tags = list(first) if index == 0 else []
            if meter and number == 0 and bar.beats != beats_in_bar:
                tags.append(f"\\ts ({bar.beats} 4)")
                beats_in_bar = bar.beats
            if tags:
                bar_lines[index] = " ".join(tags) + " " + bar_lines[index]
        lines.extend(bar_lines)
    return lines


def _tempo(bpm: float | None, beats: Sequence[float]) -> int:
    """The tempo marking: the grid's own figure, or one worked out from the
    spacing of its beats. Only a marking: the sync points keep the time."""
    value = float(bpm) if bpm else 0.0
    if value <= 0 and len(beats) > 1:
        value = 60.0 / statistics.median(b - a for a, b in zip(beats, beats[1:], strict=False))
    low, high = _TEMPO_RANGE
    return int(min(high, max(low, round(value or 120.0))))


def sync_lines(bars: Sequence[Bar], beats: Sequence[float]) -> list[str]:
    """One sync point per bar, at the time of the bar's first beat, and one at
    the end of the last bar. alphaTab moves evenly between them, so the cursor
    reaches each bar line as that bar's downbeat is heard, whatever the tempo
    does in between."""
    lines = [f"\\sync ({i} 0 {round(beats[bar.start_beat] * 1000)})" for i, bar in enumerate(bars)]
    if bars and len(beats) > 1:
        # The grid has no time for the end of its last beat: it lasts as long
        # as the beat before it.
        end = beats[-1] + (beats[-1] - beats[-2])
        lines.append(f"\\sync ({len(bars) - 1} 0 {round(end * 1000)} 1)")
    return lines


def alphatex_score(
    parts: Mapping[str, Sequence[QNote]],
    bars: Sequence[Bar],
    beats: Sequence[float],
    steps_per_beat: int,
    *,
    title: str = "",
    bpm: float | None = None,
    key_name: str | None = None,
    scale: str | None = None,
    tabs: Mapping[str, TabStaff] | None = None,
    split_unplaced: bool = True,
) -> str:
    """The score as alphaTex text.

    ``parts`` maps a stem name to its quantised notes, in the order the tracks
    are to appear. ``bars`` are the grid's bars and ``beats`` its beat times in
    seconds. ``steps_per_beat`` is the resolution the notes were quantised at.
    ``tabs`` gives, for each fretted stem, how it is drawn and its fingering;
    a stem not in it is staff notation.

    A note the instrument cannot play is kept on a staff of its own beside
    the tab, which is what a reader wants to see. A tab editor wants one
    staff per instrument: with ``split_unplaced`` false such notes are left
    out instead, and every fretted stem is a single staff.
    """
    key = key_of(key_name, scale)
    lines = [
        f"\\title ({_text(title or 'Transcription')})",
        f"\\subtitle ({_text('Transcribed by StemDeck')})",
        f"\\tempo ({_tempo(bpm, beats)})",
    ]
    for index, (stem, notes) in enumerate(parts.items()):
        tab = (tabs or {}).get(stem)
        lines.extend(
            _track(stem, notes, bars, steps_per_beat, key, tab, index == 0, split_unplaced)
        )
    lines.extend(sync_lines(bars, beats))
    return "\n".join(lines) + "\n"
