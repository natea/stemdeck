# Note galaxy: the look

## Art direction (the target)

No target image was generated: this environment has no image generator, and no reference picture was supplied (see `design.md`, "Target images for dream-loop"). The target is this text, and the dream-loop judge scores screenshots against it.

- **Subject.** A spiral galaxy seen from above at a tilt, filling most of the picture, turning slowly. One spiral arm per stem, all winding the same way out of a small pale core, evenly spaced around it.
- **Arms.** Each arm is a loose trail of small faint stars in its stem's colour (vocals red, drums orange, bass amber, guitar green, piano violet, other blue-grey). The arms are quiet scenery: dim enough that the notes are what the eye goes to, bright enough that six arms can be counted. An arm brightens a little while its stem is loud.
- **Notes.** A note is a point of light on its stem's arm, at a distance from the centre set by its pitch: low notes near the core, high notes at the rim. While the note sounds the point is lit, larger for a note played harder. At the moment it starts it throws out a burst of small particles in its stem's colour that drift outward and fade within about a second and a half. A chord is several bursts at once along one arm.
- **Light.** Particle-on-black: a near-black blue space (`#04070d`), soft round additive dots, a glow around the bright ones. The only white is the core and the centres of the loudest notes. No hard edges anywhere.
- **Mute.** A muted stem's arm fades almost to nothing and its notes make no light.
- **Camera.** Fixed, looking down at about 40 degrees, the whole disc in view with a margin.
- **Calm version (reduce motion).** The galaxy does not turn and nothing bursts: a note is a steady dot that appears while it sounds and fades away. No glow.

## Songs it was checked on

The two songs in the developer's library that had notes, in a preview copy of it, on 2026-11-22:

- **Song A**, "change-my-mind": 207 s, every stem transcribed (5,365 notes, 2,727 of them guitar).
- **Song C**, "Old Town Road": 157 s, every stem transcribed (2,204 notes).

## Critique

dream-loop's judge loop: an independent agent with a fresh context each round, given only the art direction above and five screenshots (song A at 62 s and 150 s, song C at 45 s and 100 s, and song A at 62 s with the guitar muted), scoring with dream-loop's rubric: composition 0 to 3, lighting 0 to 3, materials 0 to 3, details 0 to 1. Pass is 8 of 10.

| Round | Composition | Lighting | Materials | Details | Total | Verdict |
|---|---|---|---|---|---|---|
| 1 | 2.0 | 1.75 | 2.25 | 0.5 | 6.5 | fail |
| 2 | 2.5 | 2.25 | 2.25 | 0.75 | 7.75 | fail |
| 3 | 2.5 | 2.5 | 2.5 | 0.5 | **8.0** | **pass** |

**What the last round's screenshots showed.** A tilted spiral of six faint dotted arms in the stems' colours winding out of a small white core with a soft halo, on near-black space whose corners stay the exact background colour. Sounding notes are soft round lights on their arms, low ones near the core and high ones toward the rim, each with a fine speckle of burst particles around it. Three loud guitar notes show as three green lights in a row along the green arm with pale centres. Orange drum notes and amber bass notes can be told apart side by side. With the guitar muted, the green arm is a bare trace and there is no green light at all.

**What changed between rounds.** After round 1: the camera pulled back so the disc is not cropped; the glow cut to about a third; particles made dimmer at birth so a burst no longer adds up to a white blob; brighter arms with a smaller loudness boost; the lowest pitches moved clear of the core. After round 2: a white core with a halo; particles half the size and born from nothing, so the note outshines its own burst; pale stems' arms lifted; arms carried in to the core's edge; the disc centred.

**The judge's remaining gaps at 8.0**, most important first: the outer arm's tail runs off the bottom edge in four of five screenshots while there is empty space above; some sounding notes have no hot centre and read as a clump of stars; in sparse moments the core outshines the notes; burst specks linger at arm-star brightness; the blue-grey arm is still the weakest; near-side arm stars are drawn larger than far-side ones.

**Changed after the last verdict, and not judged.** The camera was pulled back about 8% and aimed further toward the near side, for the first gap. The rest were left.
