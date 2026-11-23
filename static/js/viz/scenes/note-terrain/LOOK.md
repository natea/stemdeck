# Note terrain: the look

## Art direction (the target)

No target image was generated: this environment has no image generator, and no reference picture was supplied (see `design.md`, "Target images for dream-loop"). The target is this text, and the dream-loop judge scores screenshots against it.

- **Subject.** The song as a landscape of blocks seen from above and behind, like looking down a valley. Time runs straight into the screen. The present moment is a thin bright line across the ground near the bottom of the picture, and the landscape slides toward it.
- **Blocks.** Stylised voxels, not realism: flat-shaded boxes with clean edges, heights in visible steps. A note is a short run of blocks at its pitch (low pitches left, high pitches right), as tall as it was played hard, stepping down along its length the way a struck note dies away. A stem with no notes is a ridge of blocks whose height is its loudness, with lower shoulders either side so it reads as a range of hills.
- **Colour.** Each stem is the colour StemDeck gives it (vocals red, drums orange, bass amber, guitar green, piano violet, other blue-grey) and no other hue is used for music. Blocks still to come are that colour at half strength; blocks at the present line are lit to near white with a soft glow of their own colour; blocks already passed are almost black. A muted stem keeps its shape and loses its colour.
- **Ground and depth.** Near-black blue ground (`#050b10` sky, `#0a121a` floor). Faint lines across the ground on beats, slightly stronger on bars, only when the song has a beat grid. Sections show as a thin coloured rail along both edges. The far end dissolves into fog of the background colour: nothing pops in.
- **Light.** One soft sky light and one sun from the upper left, so tops read lighter than sides. The only bright things are the present line and the blocks on it. The glow is gentle: it must never wash out the block edges.
- **Camera.** Fixed above and behind the present line, looking down the valley, with a slow sideways drift of under a block's width. The whole width of the landscape is in view at the line.
- **Calm version (reduce motion).** Nothing travels: the landscape shows one twelve-second page of the song, the present line walks along it, and the page changes when the line reaches its end. No glow.

## Songs it was checked on

Three songs from the developer's library, in a preview copy of it, on 2026-11-22. The task asked for "dense rock, sparse acoustic, and one with no notes and no sections"; the library had three songs, so these are what they were, described by their data rather than by a genre I have not checked:

- **Song A**, "change-my-mind": 207 s, 136 beats a minute, every stem transcribed (5,365 notes, 2,727 of them guitar), one marked section. The densest of the three.
- **Song B**, "Don't You Worry 'Bout A Thing": 285 s, 123 beats a minute, viewed with no notes and no sections, so every stem is a loudness ridge.
- **Song C**, "Old Town Road": 157 s, 136 beats a minute, every stem transcribed (2,204 notes), no sections. The sparsest.

## Critique

dream-loop's judge loop: an independent agent with a fresh context each round, given only the art direction above and five screenshots (song A at 62 s and 150 s, song B at 95 s, song C at 45 s, and song A at 62 s with the guitar muted), scoring with dream-loop's rubric: composition 0 to 3, lighting 0 to 3, materials 0 to 3, details 0 to 1. Pass is 8 of 10. Three rounds were allowed and three were spent.

| Round | Composition | Lighting | Materials | Details | Total | Verdict |
|---|---|---|---|---|---|---|
| 1 | 1.6 | 1.5 | 1.6 | 0.4 | 5.1 | fail |
| 2 | 2.2 | 2.0 | 2.2 | 0.6 | 7.0 | fail |
| 3 | 2.4 | 2.3 | 2.4 | 0.6 | **7.7** | **fail, 0.3 short** |

**What the last round's screenshots showed.** A dark valley seen from above and behind, a white line across it at about nine tenths of the way down. In songs A and C, runs of small stem-coloured blocks at their pitches, stepping down along each note, lit to a pale glowing tint where they sit on the line and black once past it. In song B, four solid stepped ridges side by side (red, orange, amber, green) with their tops lighter than their sides and the blocks on the line glowing. With the guitar muted, its blocks are grey and keep their shape. Faint beat lines and stronger bar lines cross the ground.

**What changed between rounds.** After round 1: only the blocks on the line light up, not the whole note; every stem is lit to the same brightness whatever its hue; a muted stem is grey, not dark green; the picture is framed on what is drawn; the line is one level strip; a narrower lens. After round 2: a block stays lit for one more block's length and then fades, so a dark block no longer stands in front of the lit ones; a fill light from the viewer's side; a visible glow; ridges are solid with no gaps; fog measured from the line, not the camera.

**The judge's remaining gaps at 7.7**, most important first:

1. The glow was uneven by hue: vocals lit as flat pink with no halo, green burned to white, and lit amber and orange merged.
2. Ridge sides show jagged steps between neighbouring columns of different heights.
3. The muted stem's grey was brighter than the other stems' unlit blocks.
4. Some beat lines were broken into segments.
5. Blocks in mid-fade just past the line read as blocks still to come.
6. Outer blocks lean outward (the lens), and the far end reached the top edge instead of dissolving.

**Changed after the last verdict, and not judged.** Gaps 1, 3, 4, 5 and the second half of 6 were addressed: a lower, evener lit brightness with a tighter glow; a darker muted grey; beat lines lifted clear of the ground; a fade that drops away from lit quickly; fog that finishes before the top edge. Gap 2 is the voxel look itself and was left. Nobody has scored the picture since, so the standing verdict is 7.7.
