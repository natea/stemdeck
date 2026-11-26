# Proposal

## Why

StemDeck already turns a recording into a playalong: stems you can mute, a bar grid, loops, slow-down, transposition and transcribed notes. It knows nothing about the harmony of the song, so it cannot help with the hard part of learning to improvise on standards: remembering the changes, hearing where you are in the form, and practising in every key. Two books describe a method for exactly that. Conrad Cork's *The New Guide to Harmony with LEGO Bricks* treats a song as a handful of named chord patterns ("bricks") connected by twelve named moves ("joins"). John Elliott's *Insights in Jazz* extends the brick set, draws each song as a one-page roadmap, and orders the bricks by how many songs each one unlocks. StemDeck has every part the method asks for except the harmony layer, and the stems make it a better playalong than the one the books ship with.

## What Changes

- Add a **chord chart** to a song: the changes for one chorus, typed or pasted as text, laid out on the song's existing bar grid, with a marker for where each chorus starts in the recording. StemDeck does not detect chords, so the chart comes from the user.
- Add a **brick and join library**: a built-in catalogue of the cadences, turnarounds, larger blocks and the twelve joins from both books, each stored in a key-independent form, with a short description and a way to hear it in any key.
- Add **automatic analysis**: StemDeck reads a chord chart and names the bricks, the joins between them, hovers, and where the song is at home or away. The user can correct any label.
- Add a **Roadmap view** (marked Labs) that draws the song as a grid of eight bars per row, with sections, bricks and joins above the chords. It follows playback, shows the song in any key or for a transposing instrument, and lets the user loop a brick or a section with one click.
- Add **practice drills** built on the books' practice method:
  - a generated backing (bass, chords, click) for one brick repeated in one key, and for one join carried through every key it reaches;
  - "all keys" practice on a real recording: loop a brick or a phrase and step the transposition through the keys;
  - a **"where am I?"** drill that starts a song at a random point with the roadmap hidden;
  - an **ear quiz** for joins and bricks, and a timed quiz on the cycle and scale degrees;
  - a **learning path** that says which brick to learn next and which songs in the user's library it unlocks, counted from the user's own charts.
- Add **phrase collections**: save a stretch of any stem as a phrase filed under the brick it was played over, see its transcribed notes as scale degrees, and practise it slowly and then through all twelve keys.
- Credit both books and their authors in the app and the docs.

Not in this change:

- Automatic chord recognition from audio. It is the obvious follow-up; this change makes the chart format it would fill.
- Built-in charts or roadmaps for any song. Elliott's 200+ roadmaps are his published analyses and are not copied. Users bring their own charts.
- Any text, recording or page from either book, and the word "LEGO" in the product (a trademark the first book uses by special permission).
- Importing charts from iReal Pro or other apps, chord symbols in the notation view and its exports, a roadmap in the phone UI, melody or lyric display, and advice on which notes to play.

## Capabilities

### New Capabilities

- `chord-charts`: a song's changes for one chorus, entered or pasted as text, aligned to the bar grid and to each chorus in the recording, stored with the song and served to the app.
- `harmony-bricks`: the built-in catalogue of bricks and joins in key-independent form, and the analysis that reads a chord chart and names the bricks, joins, hovers and home-or-away state in it.
- `song-roadmaps`: the Roadmap view for one song, the user's corrections to the analysis, display in any key, following playback, and looping from the roadmap.
- `practice-drills`: generated brick and join backings, all-keys practice on real recordings, the "where am I?" drill, the ear and knowledge quizzes, practice progress, and the learning path.
- `phrase-collections`: phrases saved from stems, filed by brick, shown as scale degrees, and practised through the keys.

### Modified Capabilities

None. The project has no archived specs yet, and this change does not alter the requirements of the capabilities in the other open changes (`stem-transcription`, `notation-view`, `notation-export`, `tablature`, `remote-transcription`, `stem-visualizers`). It reads transcribed notes and the bar grid as they are.

## Impact

- **Backend** (`app/api`, `app/core`): new per-song files for the chord chart and saved phrases, a library-wide file for practice progress, and the endpoints to read and write them. No new pipeline stage, no new model, no new Python dependency.
- **Frontend** (`static/js`, `static/css`, `static/index.html`): a new harmony module (chord parsing, brick catalogue, analysis, roadmap view, drills, phrase collections), a Roadmap button on the sidebar rail with a Labs badge, a Guide entry, and strings in all ten languages. No new vendored library; the drill backing is synthesised with Web Audio the way the click already is.
- **Playback**: uses the existing loop, speed, transposition, metronome and count-in. Drills that make their own sound pause the song while they run.
- **Offline and privacy**: everything runs locally. No network request is added.
- **Tests and docs**: Python tests for the new endpoints and files, Node tests for the parser, catalogue and analysis, Playwright specs for the view and drills with entries in `tests/e2e/spec-map.json`, a `docs/harmony.md` guide, and new endpoints in `docs/api.md`.
- **Licensing**: the brick formulas are facts about chord progressions; the names are the authors' coinages and are used with credit. The two source PDFs are personal, watermarked copies and must never be committed to the repository.
