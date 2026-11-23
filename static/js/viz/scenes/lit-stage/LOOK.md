# Lit stage: the look

## Art direction (the target)

No target image was generated: this environment has no image generator, and no reference picture was supplied (see `design.md`, "Target images for dream-loop"). The target is this text, and the dream-loop judge scores screenshots against it.

- **Subject.** A small dark stage seen from the front row, a little above: the instruments of a band with nobody playing them, lighting up by themselves as the song plays. Low-poly and plain: flat-shaded boxes, faceted drums, no textures, no people.
- **Layout.** A full piano keyboard along the front edge, tilted toward the viewer. A drum kit in the middle behind it: a kick drum facing forward, snare, hi-hat, two rack toms, a floor tom, a crash and a ride on thin stands. Two fretboards hang above and behind the kit like signs, drawn the way a tab is read: nut at the left, lowest string at the bottom, a six-string guitar board on the left and a four-string bass board on the right. Between them a thin vertical rail for the voice. Along the back, above everything, a bar of twelve small lamps.
- **Unlit state.** Everything is dark blue-grey on a near-black stage (`#05080d`). Each instrument carries one thin trim in its stem's colour so it can be told whose it is: piano violet on the keyboard, green on the guitar board, amber on the bass board, orange on the kick's hoop, red on the voice's rail, blue-grey on the lamp bar. The white keys are a muted grey, not white, so a lit key stands out.
- **Lit state.** A note lights exactly one thing in its stem's colour: its key, its string-and-fret spot, its drum piece, its lamp. The light is at full strength while the note sounds, with a soft glow, and fades over about a third of a second afterwards. A chord is several keys or spots at once. The voice is a glowing ball that sits on the rail at a height set by the sung pitch, there only while a note is sung.
- **Light.** Dark and theatrical: the lit things are the brightest in the picture by a wide margin and the stage itself is dim but readable. No white light anywhere except the hottest centre of a lit thing.
- **A stem with no notes yet.** Its instrument stays on stage with a grey trim and never lights, and one line of text over the picture names it.
- **Mute.** A muted stem's instrument stops lighting and its trim dims.
- **Camera.** Fixed. Everything on stage fits in the picture with a margin.
- **Calm version (reduce motion).** The same stage with gentler light: lower peaks, a slower fade, no glow.

## Songs it was checked on

The two songs in the developer's library that had notes, in a preview copy of it, on 2026-11-22:

- **Song A**, "change-my-mind": 207 s, every stem transcribed (5,365 notes; 1,295 drum hits, 97 piano notes).
- **Song C**, "Old Town Road": 157 s, every stem transcribed (2,204 notes; 735 piano notes, 89 drum hits).

## Critique

dream-loop's judge loop: an independent agent with a fresh context each round, given only the art direction above and seven screenshots (song A at 30 s, 62 s and 150 s, song C at 45 s and 100 s, song A at 62 s with the guitar muted, and song A at 62 s viewed as if the guitar had never been transcribed), scoring with dream-loop's rubric: composition 0 to 3, lighting 0 to 3, materials 0 to 3, details 0 to 1. Pass is 8 of 10. Three rounds were allowed and three were spent.

| Round | Composition | Lighting | Materials | Details | Total | Verdict |
|---|---|---|---|---|---|---|
| 1 | 2.5 | 1.75 | 1.75 | 0.5 | 6.5 | fail |
| 2 | 2.5 | 2.25 | 2.0 | 0.5 | 7.25 | fail |
| 3 | 2.6 | 2.3 | 2.3 | 0.6 | **7.8** | **fail, 0.2 short** |

**What the last round's screenshots showed.** A dark oval stage wholly in frame. A grey keyboard along the front with a thin violet line above it; behind it a faceted drum kit, its kick a dark head inside a thin orange hoop; above, a six-string board edged in green on the left and a four-string board edged in amber on the right, a red rail between them, and a bar of twelve dim lamps across the top. Lit things are small bright marks in their stems' colours: green and amber squares on the fretboards with soft halos, a piano key lit pale violet with a halo, orange cymbals and drums, a pink ball on the rail. With the guitar muted its board's trim is dark green and nothing on it lights. With the guitar untranscribed its trim is grey and "No notes yet: Guitar" reads at the bottom left.

**What changed between rounds.** After round 1: the kick's hoop made a ring so its head is dark at rest; keys dimmed to grey and drawn in flat colour so a lit key glows; every stem lit to the same brightness whatever its hue; fret spots hidden until they sound; a lighter floor edge and lamp housings; the voice's rail ended below the lamp bar; a more legible caption. After round 2: only the kick's front head lights; all six guitar strings wide enough to draw; frets as single straight pieces; a cap on brightness so lit things keep their hue; wider gaps between keys; a smaller floor and a camera pulled back; faceted drums in a lighter grey.

**The judge's remaining gaps at 7.8**, most important first:

1. The kick's head burned to pale yellow at full strength, and its glow tinted the whole stage.
2. Drums either glowed strongly or not at all, depending on how far through their fade they were.
3. The voice's ball was a flat pink disc with no glow.
4. Fret and string lines were still jagged and uneven in width (thin lines on a tilted board).
5. A lit piano key's body was white, with the violet only in its halo; gaps between keys vanished toward the keyboard's ends.
6. The keyboard overhung the floor's front edge.

**Changed after the last verdict, and not judged.** The kick's head is lit less hard than the smaller drums, the cap on brightness was lowered so a lit key stays violet, and the glow was tightened with a lower threshold so a fading drum keeps a small halo. Gaps 3, 4 and 6 were left. Nobody has scored the picture since, so the standing verdict is 7.8.
