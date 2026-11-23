# Drive the song: the look

## Art direction (the target)

No target image was generated: this environment has no image generator, and no reference picture was supplied (see `design.md`, "Target images for dream-loop"). The target is this text, and the dream-loop judge scores screenshots against it.

- **Subject.** A night drive down a straight road, seen from the driver's seat, low and looking ahead to a vanishing point in the middle of the picture. Low-poly and plain: flat boxes, no textures, no car bonnet, no dashboard.
- **The road.** A dark grey strip with a thin lighter kerb each side, running to the horizon. A short dash down the middle on every beat and a pale line right across the road on every bar, only when the song has a beat grid. A beat is always the same length of road, so a faster song passes faster.
- **Drum hits.** Each drum hit is a low bump lying across the road in the drums' orange, wider and taller for a harder hit, and the view lifts a little as it passes underneath at the moment it is heard. They come from the drum stem's notes, or from its loudness when it has none.
- **The other stems.** Each other stem is a row of square posts beside the road, the nearest stem closest to the kerb, alternating left and right, in its stem's colour with a brighter cap. A post is as tall as its stem is loud at that point of the road, and a silent stretch has no posts. Together they read as a skyline that rises and falls with the music.
- **Sections.** Each section is a change of scenery: the land either side of the road carries a broad strip of the section's colour for as long as the section lasts, and the sky and the fog take a tint of it while the viewer is inside it.
- **Light.** Night: near-black blue sky and land (`#060a12`, `#0c141d`), fog of the sky's colour that swallows the far end so nothing pops in. The posts' caps are the brightest things and glow a little.
- **Mute.** A muted stem's posts go almost black and keep their shape. Muted drums leave dark bumps and no lift.
- **Camera.** At eye height above the road, moving along it with the song.
- **Calm version (reduce motion).** The viewer stands still, high above one sixteen-beat page of road at a time, and a small pale car travels along it; the page changes when the car reaches its end. No lift on bumps, no glow.

## Songs it was checked on

Three songs from the developer's library, in a preview copy of it, on 2026-11-22. The task asked for "dense rock, sparse acoustic, and one with no notes and no sections"; the library had three songs, so these are what they were, described by their data:

- **Song A**, "change-my-mind": 207 s, 136 beats a minute, every stem transcribed (1,295 drum hits, about six a second), one marked section from 98 s to 123 s.
- **Song B**, "Don't You Worry 'Bout A Thing": 285 s, 123 beats a minute, viewed with no notes and no sections, so its bumps come from the drums' loudness.
- **Song C**, "Old Town Road": 157 s, 136 beats a minute, every stem transcribed (89 drum hits), no sections.

## Critique

dream-loop's judge loop: an independent agent with a fresh context each round, given only the art direction above and screenshots (song A at 62 s, 150 s and, from round 2, 110 s inside its section; song B at 95 s; song C at 45 s; and song A at 62 s with the guitar muted), scoring with dream-loop's rubric: composition 0 to 3, lighting 0 to 3, materials 0 to 3, details 0 to 1. Pass is 8 of 10.

| Round | Composition | Lighting | Materials | Details | Total | Verdict |
|---|---|---|---|---|---|---|
| 1 | 2.2 | 1.8 | 2.0 | 0.5 | 6.5 | fail |
| 2 | 2.4 | 2.2 | 2.4 | 0.7 | 7.7 | fail |
| 3 | 2.5 | 2.3 | 2.5 | 0.7 | **8.0** | **pass, marginal** |

**What the last round's screenshots showed.** A straight dark road to a central vanishing point with thin kerbs, seen from the driver's seat at night. Low orange bumps lie across it, separate near the viewer and merging far away in song A's busy drum part. Rows of square posts stand either side in the stems' colours with bright flat caps, two rows a side in song A, their heights rising and falling. Pale bar lines cross the road inside the kerbs. The far end fades into fog. With the guitar muted its posts are near-black and keep their shape. Inside song A's section the sky and the land turn blue.

**What changed between rounds.** After round 1: bumps made half as tall and half as deep and darker; fog brought much nearer (from eye height a distant fog covers only a few pixels); caps lit to one brightness whatever the hue, with a glow; rows spaced further apart; bar lines moved clear of downbeat bumps; a narrower lens and shorter posts. After round 2: rows shared between the two sides by how many posts each stem has; a gentler glow and caps short of burning out; a weaker section tint; rows further from the kerb; bar lines kept to the road's width.

**The judge's remaining gaps at 8.0**, most important first: the section tint is still dusk rather than night, and repaints all the land rather than a strip (the judge named this as the item most likely to cost the pass on another reading); amber caps bleach at their centres and their halo warms the sky on one side; posts nearest the viewer are cut by the frame; song A's far bumps merge into one orange patch; bumps of hits very close together overlap; beat dashes are small and mostly hidden under bumps.

**Changed after the last verdict, and not judged.** The section tint on sky, fog and land was cut to less than half again. The rest were left.
