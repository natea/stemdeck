# Slit-scan score: the look

## Art direction (the target)

No target image was generated: this environment has no image generator, and no reference picture was supplied (see `design.md`, "Target images for dream-loop"). The target is this text, and the dream-loop judge scores screenshots against it.

- **Subject.** The whole song at a glance, as one flat strip read left to right like a slit-scan photograph: each column is one moment. It is a score for people who do not read scores. Deliberately flat: no perspective, no depth, nothing between the eye and the data.
- **Bands.** One horizontal band per stem, stacked with a thin gap, vocals at the top, in the order StemDeck lists stems. A band is its stem's colour and nothing else. Its brightness in each column is the stem's loudness at that moment, so quiet passages are dark and loud ones bright, and a silent stretch is a nearly black gap.
- **Notes.** Where a stem has notes, its band is drawn dimmer and each note is a crisp bright mark, almost white with a tint of the stem's colour, at a height inside the band set by its pitch (low notes low, high notes high) and as long as the note lasts. A melody reads as a line that rises and falls.
- **The present moment.** One thin white vertical line through all the bands, a little taller than the strip, with a slight glow. Everything to its right, the part of the song still to come, is drawn at about half brightness, so the strip fills with light as the song plays.
- **Furniture.** Above the strip, a thin bar of the sections' own colours when the song has sections. Below it, a ruler of small ticks on every bar, a taller one every fourth bar, when the song has a beat grid. No text.
- **Ground.** Near-black blue background (`#050b10`), generous margins left and right, the strip filling most of the height.
- **Mute.** A muted stem's band stays where it is and goes almost black.
- **Calm version (reduce motion).** The same picture without the glow. Only the thin line moves.

## Songs it was checked on

Three songs from the developer's library, in a preview copy of it, on 2026-11-22. The task asked for "dense rock, sparse acoustic, and one with no notes and no sections"; the library had three songs, so these are what they were, described by their data:

- **Song A**, "change-my-mind": 207 s, every stem transcribed (5,365 notes), one marked section.
- **Song B**, "Don't You Worry 'Bout A Thing": 285 s, viewed with no notes and no sections, so every band is loudness only.
- **Song C**, "Old Town Road": 157 s, every stem transcribed (2,204 notes), no sections.

## Critique

dream-loop's judge loop: an independent agent with a fresh context each round, given only the art direction above and five screenshots (song A at 62 s and 150 s, song B at 95 s, song C at 45 s, and song A at 62 s with the guitar muted), scoring with dream-loop's rubric: composition 0 to 3, lighting 0 to 3, materials 0 to 3, details 0 to 1. Pass is 8 of 10.

| Round | Composition | Lighting | Materials | Details | Total | Verdict |
|---|---|---|---|---|---|---|
| 1 | 2.4 | 2.0 | 2.0 | 0.5 | 6.9 | fail |
| 2 | 2.6 | 2.2 | 2.3 | 0.7 | 7.8 | fail |
| 3 | 2.7 | 2.5 | 2.6 | 0.8 | **8.6** | **pass** |

**What the last round's screenshots showed.** Six bands stacked in StemDeck's order across most of the canvas on a near-black ground, each its stem's colour, with generous margins. In song B the bands are textured with loudness alone: bright where the song is loud, nearly black where a stem rests. In songs A and C the bands are dimmer and carry crisp pale marks at their pitches, so the vocal and bass lines read as rising and falling melodies and the drums as rows of hits. A thin white line with a soft halo marks the present. To its right everything measures about half the brightness of the same stretch once played, with its hue kept. A ruler of ticks runs under the strip, a taller one every fourth bar, and song A has one thin section bar above it. The muted guitar band keeps its place and is almost black, marks included.

**What changed between rounds.** After round 1: the part still to come made clearly darker; the line's glow drawn by the scene itself as a halo along its whole length; a muted band's marks dimmed with it; a floor of colour under quiet stems that have notes; a clearer ruler; wider margins; a thinner, dimmer section bar; marks kept clear of band edges. After round 2: the part still to come set to about half by a plain black veil so hue is kept; the halo made a smooth falloff; a muted band taken down to about a tenth; the line snapped to whole pixels.

**The judge's remaining gaps at 8.6**, most important first: the halo is heavier than "slight" and washes out marks within a few pixels of the line; a dark rail in the empty section-bar row to the right of the line, even in songs with no sections; silent stretches merge with the ground so the stack loses its outline; a small step at the halo's outer edge; fine drum marks blur into the band's texture; marks are more tinted than "almost white".

**Changed after the last verdict, and not judged.** The halo's peak was roughly halved and eased to nothing at its edge, and the section-bar row is only dimmed when the song has sections. The rest were left.
