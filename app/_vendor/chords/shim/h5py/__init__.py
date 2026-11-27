"""A stand-in for h5py that holds nothing.

lv-chordia imports h5py at the top of lv_chordia/mir/nn/data_storage.py, the
storage its training code reads datasets from. Naming the chords of a song
never opens a dataset, so nothing here is ever asked for. h5py is a compiled
library StemDeck does not ship; this module only lets that import succeed in
the chord worker (app/pipeline/chord_engine.py puts this folder on sys.path
there and nowhere else).

Anything that does ask for a name gets a plain error saying so, rather than
an AttributeError from deep inside the package.
"""


def __getattr__(name: str):
    if name.startswith("__"):
        raise AttributeError(name)
    raise RuntimeError(f"h5py is not part of StemDeck (lv-chordia asked for h5py.{name})")
