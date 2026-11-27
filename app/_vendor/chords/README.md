# Vendored chord model

What names the chords of a song (app/pipeline/chords.py). Only the chord
worker process (app/pipeline/chords_worker.py) puts this folder on `sys.path`,
through `app/pipeline/chord_engine.py`; the server process never imports
anything in it.

## Why it is vendored

`pip install lv-chordia` would add a dependency, which changes `uv.lock` and
sends every existing desktop install to a full reinstall (the same reason
app/_vendor/transcribe gives). It would also install pretty-midi, mido and
importlib-resources beside the copies vendored for MIDI, which the server
must not be able to import, and h5py, a compiled library the model never
uses to name a chord. Here, under `app/`, the model ships with the in-app
update, the Docker image and every package with no packaging change.

It runs on what `uv.lock` already has: torch, librosa, numpy, joblib and
pydub.

## What is here

The wheel unpacked as PyPI ships it: the package folder and its `.dist-info`
(METADATA, RECORD, the licence file). Nothing in them is edited.

| Package | Version | Licence | Wheel sha256 |
|---|---|---|---|
| lv-chordia | 1.1.0 | MIT | `292241f03e1029e6739ee7a2a91fbe348c25c97b8b3641db76cbef9f9dee0cb0` |

Source: the `bdist_wheel` file of the release on PyPI, URL in
`manifest.json`. lv-chordia is an inference-only packaging, kept by
openmirlab, of the research code of Jiang, Chen, Li and Xia,
"Large-Vocabulary Chord Transcription via Chord Structure Decomposition"
(ISMIR 2019, Music X Lab). 1.1.0 is the last release on PyPI.
`manifest.json`'s `id` is the first 16 hex characters of the sha256 of the
wheel's hash.

Left out, and listed in `manifest.json` under `removed`:

- `lv_chordia-1.1.0.data/.../cache_data/*.sdict`: the five checkpoints,
  28.7 MB together. They are downloaded on first use instead (see below).
- `lv_chordia/data/cross_weight*.pkl`, `cross_subpart_weight*.pkl`: ten
  pickled tables of training-time loss weights. Naming a chord never opens
  them (`ChordNet(None)` in `lv_chordia/chord_recognition.py`), and a pickle
  that is not needed is better not shipped.
- `lv_chordia/data/train*.csv`, `test*.csv`, `all_1217.csv`,
  `complex_chord_structure.xlsx`, `chordino.n3`, `midi_template.svl`,
  `chord_placeholder.lab`: the training lists and files for other tools.

What is left of `lv_chordia/data/` is the four chord lists the decoder reads.

One file here is StemDeck's own: `shim/h5py/__init__.py`, a stand-in that
holds nothing. The package imports h5py at the top of its training storage
(`lv_chordia/mir/nn/data_storage.py`); a chord run never asks it for
anything. The worker puts `shim/` on `sys.path` so that import succeeds.

The package also imports pretty_midi, which brings mido and
importlib_resources. The worker takes them from `app/_vendor/transcribe`,
the copies vendored for MIDI: pretty-midi 0.2.11.post0 there is the version
lv-chordia asks for.

`.gitattributes` marks this folder `-text`, so git never rewrites a line
ending in it. `tests/test_chords_vendor.py` checks every package file against
the wheel's RECORD hash and fails on anything changed, missing or added.

## The checkpoints

Five files, `joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s0` to
`_s4`, `.best.sdict`. The parent downloads them the first time chords are
detected, or from Settings > Models, from the authors' own repository at a
fixed commit:

    https://raw.githubusercontent.com/music-x-lab/ISMIR2019-Large-Vocabulary-Chord-Recognition/481f4ce703f8822b99f4037e9104ba1760e21ea3/cache_data/

into `<models folder>/lv_chordia/`. Each is kept only at its pinned size and
SHA-256 (`CHORDS_CHECKPOINT_SIZE` and `CHORDS_CHECKPOINT_SHA256` in
app/core/config.py), and the worker checks each SHA-256 again before the
model loads. The same five files, byte for byte, are in the wheel:
`tests/test_chords_vendor.py` compares the pinned hashes with the wheel's
RECORD.

## Licences

MIT for the package: its metadata says so and the text is in
`lv_chordia-1.1.0.dist-info/licenses/LICENSE` ("Copyright (c) 2023 Music X
Lab"). The checkpoints come from the authors' repository, which is MIT by its
LICENSE file. The packaged third-party notices
(packaging/*/THIRD_PARTY_NOTICES.txt) name them. docs/models.md has the rest.

## How to update

1. Pick the new version on PyPI. Check the project's licence for changes,
   and that the wheel is still pure Python (`py3-none-any`).
2. Fetch the wheel's sha256 from `https://pypi.org/pypi/lv-chordia/<version>/json`
   (`urls[]`, the `bdist_wheel` entry) and write it into the table above and
   into `EXPECTED` in `tests/test_chords_vendor.py`.
3. Download the wheel from the URL in that JSON into an empty folder outside
   the repository and check its sha256 against the published one.
4. Delete this folder's package and `.dist-info` folders and unpack the wheel
   here: the package folder and its `.dist-info` only, minus the files listed
   above. Check each unpacked file against the wheel's RECORD.
5. Rewrite `manifest.json` (version, wheel, url, sha256, size, removed,
   files, and the `id`).
6. If the checkpoints changed, pin the new commit, sizes and hashes in
   app/core/config.py, and check they are the files in the wheel.
7. Check what the package imports: a new import the environment lacks needs
   a decision here, not a new dependency.
8. Run `STEMDECK_TEST_REAL_MODELS=1 uv run pytest tests/test_chords_real_model.py`
   and the chord tests.
