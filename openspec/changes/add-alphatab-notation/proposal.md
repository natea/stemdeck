# Proposal

## Why

The `add-stem-transcription` change turns stems into notes, but the only way to see them is to download a file and open another program. A musician practising in StemDeck wants to read the part while the song plays, and a guitarist or bassist wants tablature, not only staff notation. alphaTab is an open-source (MPL-2.0) notation and tablature renderer for the browser with no dependencies of its own, and it can follow an outside audio clock, which is what StemDeck's player is.

This change depends on `add-stem-transcription` and is built after it.

## What Changes

- Add a **Notation view** that shows a song's transcribed stems as engraved music inside StemDeck, rendered with a vendored copy of alphaTab.
- **Follow playback**: a cursor moves through the score in time with StemDeck's own player (including at reduced speed and inside a loop), the score scrolls with it, and clicking a bar moves the song there. StemDeck's stems stay the sound source; alphaTab's synthesiser is not used.
- **Tablature for guitar and bass**: the `guitar` and `bass` stems are shown as tab, staff notation, or both. StemDeck works out a playable string and fret for every note from a chosen tuning and capo.
- **Choices in the view**: which transcribed stems to show, staff or tab or both for fretted stems, tuning and capo, zoom, and the quantisation resolution already offered by the exports.
- **Exports for other programs**: the MIDI and MusicXML downloads from `add-stem-transcription` are offered from the view, the MusicXML score gains tablature for guitar and bass, and a **Guitar Pro (.gp)** download is added for tab editors.
- Vendor alphaTab 1.9.0 and the Bravura music font into `static/vendor/`. No build step, no CDN at runtime, no new Python dependency.

Not in this change: editing notes or fingerings in the app, chord symbols and chord diagrams, lyrics under the staff, playing the transcription back as synthesised sound, and printing.

## Capabilities

### New Capabilities
- `notation-view`: showing a song's transcription as staff notation inside StemDeck, in step with playback, with the choices of what is shown.
- `tablature`: assigning strings and frets to the notes of fretted-instrument stems from a tuning and capo, and what happens to notes the instrument cannot play.

### Modified Capabilities
- `notation-export`: adds a Guitar Pro download and tablature in the MusicXML score. This capability is introduced by `add-stem-transcription`, which is not archived yet, so the delta here only adds requirements and must be archived after that change.

## Impact

- **Frontend**: new modules under `static/js/` for the view, the alphaTab bridge and the player sync; a new entry point in the studio UI; strings in `static/js/i18n.js`; styles in `static/css/`.
- **Vendored files**: `static/vendor/alphatab/` with alphaTab's ES-module build, its worker files and `Bravura.woff2` (about 1.6 MB), each with its license file (MPL-2.0 for alphaTab, SIL OFL 1.1 for Bravura). The bundled soundfont is left out.
- **Backend**: a fingering module under `app/pipeline/`, a new score endpoint in `app/api/jobs.py` that returns the transcription in a form alphaTab reads, a tuning setting per song and stem, and string and fret data added to the MusicXML writer.
- **Security headers**: alphaTab renders in a web worker loaded from the app's own origin, which the current Content-Security-Policy allows. No policy change is expected; this is verified in the tasks.
- **Platforms**: the view needs a transcription, so it is not offered where transcription is not (Intel Macs). The mobile UI under `static/mobile/` is not changed.
- **Docs**: README feature list, `docs/api.md`, and a third-party notice for alphaTab and Bravura.
