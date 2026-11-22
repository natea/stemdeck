# Model licensing notes

Records the license basis for ML checkpoints StemDeck downloads at runtime.
Not exhaustive -- only entries where the decision wasn't a simple upstream
license file are documented here.

## Demucs (htdemucs_6s)

MIT, published by the `demucs` PyPI package (Meta/Facebook Research). No
audit needed -- an unambiguous upstream license.

## All-In-One (automatic song sections)

- **Runtime**: `all-in-one-infer` 3.x, the cross-platform inference fork of
  the All-In-One music-structure model.
- **Checkpoint**: `harmonix-all`, downloaded from the upstream Hugging Face
  repository during desktop warmup or on first use elsewhere.
- **License**: MIT for both the original All-In-One project and the
  `all-in-one-infer` runtime.
- **Upstream**: https://github.com/mir-aidj/all-in-one and
  https://github.com/openmirlab/all-in-one-infer

StemDeck runs this model on CPU after separation and passes its existing stems.
The checkpoint is not bundled in StemDeck installers.

## Whisper (lyrics transcription)

- **Runtime**: `openai-whisper` (PyPI, MIT, `openai/whisper`), on the torch
  StemDeck already ships for Demucs.
- **Checkpoints**: `large-v3-turbo` (1.6 GB) on a GPU with room for it,
  `small` (0.5 GB) on a CPU or a smaller GPU. Overridable with
  `STEMDECK_WHISPER_MODEL_GPU` / `STEMDECK_WHISPER_MODEL_CPU`.
- **License**: MIT for both the code and the published weights.
- **Upstream**: https://github.com/openai/whisper

Runs only when no lyrics were found for a job and the `transcribe_lyrics`
setting allows it (by default on a GPU only). Weights download on first use
into `<TORCH_HOME>/whisper`, or during desktop setup when transcription would
run, and are verified by Whisper's own SHA-256 check. Not bundled in StemDeck
installers.

## Stem transcription (on-demand notes from stems)

Three models, one per kind of stem, chosen by the routing table
`TRANSCRIBE_ROUTES` in `app/core/config.py`. Each stem can be sent to another
with `STEMDECK_TRANSCRIBE_<STEM>` (see [configuration](configuration.md)), so a
model that a deployment does not want is one environment variable away from
not being used. None is bundled in StemDeck installers; the two with separate
weights download them on first use into `<models>/` and check them against a
published hash before loading. All three run on the torch StemDeck already
ships: no TensorFlow.

### CREPE (vocals, lead vocals, bass)

- **Runtime**: `torchcrepe` (PyPI, MIT, `maxrmorrison/torchcrepe`), a PyTorch
  implementation of the CREPE pitch tracker. The `crepe` package itself was
  not used because it requires TensorFlow.
- **Checkpoint**: `full.pth` (89 MB), inside the `torchcrepe` wheel. Nothing is
  downloaded at run time.
- **License**: MIT for the code and the weights distributed with it. CREPE
  itself (`marl/crepe`) is MIT.
- **Upstream**: https://github.com/maxrmorrison/torchcrepe and
  https://github.com/marl/crepe

CREPE reports a pitch every 10 ms. Turning that curve into notes is StemDeck's
own code (`app/pipeline/pitch_notes.py`), with no model.

### ByteDance high-resolution piano transcription (piano)

- **Runtime**: `piano-transcription-inference` (PyPI, MIT,
  `qiuqiangkong/piano_transcription_inference`).
- **Checkpoint**: `CRNN_note_F1=0.9677_pedal_F1=0.9186.pth` (172 MB), from
  Zenodo record 4034264, published there by the model's author. MD5
  `22b961b77c1878239fec963362097045`, checked before it is loaded. StemDeck
  downloads it itself: the library's own downloader shells out to `wget` and
  writes to the home folder.
- **License**: MIT for the code. The checkpoint is published on Zenodo under
  **CC BY 4.0**, which allows any use with credit.
- **Credit**: Qiuqiang Kong, Bochen Li, Xuchen Song, Yuan Wan, Yuxuan Wang,
  "High-resolution Piano Transcription with Pedals by Regressing Onsets and
  Offsets Times" (2020).
- **Upstream**: https://github.com/qiuqiangkong/piano_transcription_inference
  and https://zenodo.org/records/4034264

**The point that needed a decision.** The model was trained on MAESTRO, whose
dataset license is CC BY-NC-SA 4.0. StemDeck turned madmom down because its
*model files* are published under CC BY-NC-SA (see `app/pipeline/beat_detect.py`).
This case is not the same: here the author published the weights themselves
under CC BY 4.0, and it is the weights StemDeck downloads and runs, not the
dataset. The decision recorded here is to use it as the default for the piano
stem, on the strength of the license the weights carry. Whether training on a
non-commercial dataset restricts the trained weights is a question the license
on the weights does not settle for everyone; a deployment that reads it the
other way sets `STEMDECK_TRANSCRIBE_PIANO=mt3` and the piano stem goes to
YourMT3+ instead, with lower accuracy on piano.

### YourMT3+ (guitar, other, backing vocals, drums)

- **Runtime**: `mt3-infer` 0.2.0 (PyPI, MIT, `openmirlab/mt3-infer`), which
  vendors the YourMT3 inference code. Pinned exactly. It needs
  `transformers` 4.45: its decoder fails on 4.46 and later, and that in turn
  holds `huggingface-hub` below 1.0 (see the comment in `pyproject.toml`).
- **Checkpoint**: `YPTF.MoE+Multi (noPS)`,
  `mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops/checkpoints/last.ckpt`
  (536 MB), from the authors' Hugging Face model repository
  `mimbres/YourMT3`. SHA-256
  `ae38e415c79efd5592dcb9b658cdb99ddb11d4c4e1eaa364cab04a052473fc25`, checked
  before it is loaded. It is the checkpoint `mt3-infer` defaults to. StemDeck
  downloads it itself with `huggingface_hub`: `mt3-infer`'s own downloader
  clones a Hugging Face Space with `git lfs`, which a desktop install cannot
  be assumed to have.
- **License**: two statements upstream. The Hugging Face model repository
  that hosts the checkpoints, and the Hugging Face Space the vendored code
  comes from, both declare **Apache-2.0**; `mt3-infer` ships that code under
  Apache-2.0 with its own wrapper under MIT. The authors' GitHub repository
  (`mimbres/YourMT3`) carries a **GPL-3.0** license file. StemDeck uses the
  code and weights as distributed under Apache-2.0. Both licenses are
  compatible with StemDeck's AGPL-3.0-only, so the choice between them does
  not change what StemDeck may do.
- **Credit**: Sungkyun Chang, Emmanouil Benetos, Holger Kirchhoff, Simon
  Dixon, "YourMT3+: Multi-instrument Music Transcription with Enhanced
  Transformer Architectures and Cross-dataset Stem Augmentation" (2024).
- **Upstream**: https://github.com/mimbres/YourMT3,
  https://huggingface.co/mimbres/YourMT3 and
  https://github.com/openmirlab/mt3-infer

**Not checked**: the license terms of each dataset this checkpoint was trained
on. The checkpoint name's `all` means the authors' full multi-dataset mix. As
with the piano model, the weights are used under the license their authors
published them with.

### Rejected alternatives

- **Basic Pitch** (Spotify, Apache-2.0): one small model for every stem, but
  its dependencies are TensorFlow or CoreML depending on the platform, and it
  is the least accurate of the candidates on every stem type.
- **`crepe`** (the original package): TensorFlow.
- **`yourmt3`** on PyPI: a third-party repackaging that pins
  `transformers==4.45.1`, adds `lightning`, and loads weights from a mirror
  that is not the authors'.
- **ADTLib and Magenta's Onsets and Frames Drums** for the drums stem: both
  are TensorFlow 1 projects that are no longer maintained. ADTLib tells only
  kick, snare and hi-hat apart; the Magenta model was trained on electronic
  kits only. ADTOF is the stronger candidate if drum accuracy needs more than
  YourMT3+ gives, at the cost of a TensorFlow runtime.

## UVR-MDX-NET Karaoke 2 (on-demand lead/backing vocal split, #275)

- **File**: `UVR_MDXNET_KARA_2.onnx`
- **Distributed via**: `audio-separator` (PyPI, MIT,
  `nomadkaraoke/python-audio-separator`), which bundles/downloads models
  trained as part of the Ultimate Vocal Remover (UVR) project by Anjok07.
- **License**: MIT + attribution, per the `audio-separator` README:
  > "If you choose to integrate this project into some other project using
  > the default model or any other model trained as part of the UVR project,
  > please honor the MIT license by providing credit to UVR and its
  > developers."
- **Credit**: Ultimate Vocal Remover (Anjok07) -- https://github.com/Anjok07/ultimatevocalremovergui

This is the shipped default (`VOCAL_SPLIT_MODEL` in `app/core/config.py`,
overridable via `STEMDECK_KARAOKE_MODEL`).

### Rejected alternative: mel_band_roformer_karaoke (aufr33/viperx)

`audio-separator`'s community-trained roformer checkpoint
(`mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt`) has meaningfully
better reported SDR than the MDX-Net Karaoke 2 model above, and was the
originally preferred choice while scoping this feature. It was rejected after
directly verifying:

- No LICENSE file was ever published for this checkpoint, nor a stated
  license anywhere in its distribution.
- It was originally released through UVR's Boosty supporter-paywall page, not
  as a public open release.
- The public Hugging Face mirror (`jarredou/aufr33-viperx-karaoke-melroformer-model`)
  now returns 401 (gated/removed) -- confirmed directly, not secondhand.

A cleanly-licensed roformer alternative (Kimberley Jensen's
`Mel-Band-Roformer-Vocal-Model`) was also checked and found to have no
LICENSE file despite a claim to the contrary surfacing in a web search.

Since StemDeck is free/non-commercial, the practical risk of using an
unlicensed-but-freely-shared community checkpoint is low -- but a
Boosty-paywall origin is a step past "unlicensed," suggesting the author did
not intend it for free redistribution at all, and its already-dead HF mirror
makes it an unreliable thing to depend on regardless of the licensing
question. `STEMDECK_KARAOKE_MODEL` remains available as an env override for a
deployment that wants to accept that risk itself.
