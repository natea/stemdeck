# Chord fixtures

`full_chord_list.txt` is the "full" chord vocabulary of `lv-chordia` 1.1.0
(`lv_chordia/data/full_chord_list.txt`, MIT, Copyright (c) 2023 Music X Lab),
copied unchanged: its 382 lines are the 380 chords the detector can report,
written on C, and its two labels that are no chord, `N` (none) and `X`
(unknown). The tests read it so that every label the model can produce is known to
parse (`tests/test_chord_labels.py`) and to get a chord symbol
(`tests/js/chords.test.mjs`). `tests/test_chord_labels.py` fails if the
installed package's list differs from this copy.
