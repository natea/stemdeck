"""Chord detection's settings, reason codes and job state
(app/core/config.py, app/core/chord_outcome.py, app/core/models.py).

Scenarios of "Detection reports progress and can be cancelled" and "A failed
detection never harms the song" in the chord-recognition spec, as far as the
job record carries them.
"""

from __future__ import annotations

import importlib
import typing

from app.core import chord_outcome, config, registry
from app.core.models import Job

JOB = "abcdef012345"


# -- settings ---------------------------------------------------------------


def test_the_vocabulary_is_the_full_one_by_default():
    assert config.chords_vocabulary({}) == "full"
    assert config.CHORDS_VOCABULARY_DEFAULT == "full"
    assert "full" in config.CHORDS_VOCABULARIES


def test_one_environment_variable_picks_another_vocabulary():
    assert config.chords_vocabulary({"STEMDECK_CHORDS_VOCABULARY": "submission"}) == "submission"
    assert config.chords_vocabulary({"STEMDECK_CHORDS_VOCABULARY": "  ISMIR2017 "}) == "ismir2017"


def test_a_vocabulary_that_does_not_exist_is_ignored():
    assert config.chords_vocabulary({"STEMDECK_CHORDS_VOCABULARY": "everything"}) == "full"
    assert config.chords_vocabulary({"STEMDECK_CHORDS_VOCABULARY": ""}) == "full"


def test_the_timeout_has_a_default_an_override_and_a_floor(monkeypatch):
    try:
        monkeypatch.delenv("STEMDECK_TIMEOUT_CHORDS", raising=False)
        assert importlib.reload(config).TIMEOUT_CHORDS == 900
        monkeypatch.setenv("STEMDECK_TIMEOUT_CHORDS", "120")
        assert importlib.reload(config).TIMEOUT_CHORDS == 120
        # A value that would stop every run before the model has loaded.
        monkeypatch.setenv("STEMDECK_TIMEOUT_CHORDS", "1")
        assert importlib.reload(config).TIMEOUT_CHORDS == 30
    finally:
        monkeypatch.undo()
        importlib.reload(config)


def test_a_chord_shorter_than_a_beat_is_not_kept():
    assert config.CHORDS_MIN_BEATS == 1.0


def test_the_five_checkpoints_each_have_a_hash():
    hashes = config.CHORDS_CHECKPOINT_SHA256
    assert len(hashes) == 5
    assert sorted(name[-13:] for name in hashes) == [f"s{i}.best.sdict" for i in range(5)]
    for digest in hashes.values():
        assert len(digest) == 64 and int(digest, 16) >= 0
    assert len(set(hashes.values())) == 5
    # Each with its size too: a download is kept only at that size.
    assert set(config.CHORDS_CHECKPOINT_SIZE) == set(hashes)
    assert sum(config.CHORDS_CHECKPOINT_SIZE.values()) == 28_730_939
    assert len(config.CHORDS_CHECKPOINT_REVISION) == 40
    assert "%" not in config.CHORDS_CHECKPOINT_URL_BASE


# -- reason codes -----------------------------------------------------------


def test_every_code_has_a_message():
    for code in chord_outcome.CODES:
        message = chord_outcome.message_for(code)
        assert message and message == chord_outcome.MESSAGES[code]
    assert chord_outcome.message_for(None) is None
    # An unknown code never leaks: it reads as the generic failure.
    assert chord_outcome.message_for("nope") == chord_outcome.MESSAGES["worker_failed"]


def test_the_codes_the_page_has_words_for_exist():
    assert {
        "dependency_missing",
        "model_download",
        "no_audio",
        "out_of_memory",
        "worker_failed",
        "timeout",
        "cancelled",
        "interrupted",
    } == set(chord_outcome.CODES)


# -- job state --------------------------------------------------------------


def test_a_new_job_has_no_chords():
    state = Job(id=JOB).to_state()
    assert state["chords"] == "none"
    assert state["chords_reason"] is None
    assert state["chords_message"] is None
    assert state["chords_progress"] is None


def test_chord_state_round_trips_through_the_record():
    job = Job(id=JOB, status="done")
    job.chords = "error"
    job.chords_reason = "timeout"
    back = Job.from_record(job.to_record())
    assert back.chords == "error" and back.chords_reason == "timeout"
    state = back.to_state()
    assert state["chords"] == "error"
    assert state["chords_message"] == chord_outcome.MESSAGES["timeout"]

    job.chords, job.chords_reason = "done", None
    assert Job.from_record(job.to_record()).to_state()["chords"] == "done"


def test_a_running_detection_makes_the_song_busy():
    job = Job(id=JOB, status="done")
    assert not job.post_hoc_running()
    job.chords = "running"
    assert job.post_hoc_running()


def test_a_restart_during_a_detection_reads_as_interrupted():
    job = Job(id=JOB, status="done", stage_message="Detecting chords...")
    job.chords = "running"
    back = Job.from_record(job.to_record())
    assert back.chords == "error"
    assert back.chords_reason == "interrupted"
    assert back.stage_message == "Done"
    assert not back.post_hoc_running()
    assert "closed before" in back.to_state()["chords_message"]


def test_progress_is_shown_only_while_running_and_never_saved():
    job = Job(id=JOB, status="done")
    job.chords = "running"
    job.chords_progress = {"phase": "detecting", "percent": 40}
    assert job.to_state()["chords_progress"] == {"phase": "detecting", "percent": 40}
    assert "chords_progress" not in job.to_record()
    # Left behind by a run that ended: the state does not show it.
    job.chords = "done"
    assert job.to_state()["chords_progress"] is None


def test_a_damaged_record_reads_as_no_chords():
    record = Job(id=JOB, status="done").to_record()
    record["chords"] = "sideways"
    record["chords_reason"] = ["not", "a", "code"]
    back = Job.from_record(record)
    assert back.chords == "none" and back.chords_reason is None


def test_a_record_from_before_chords_existed_loads():
    record = Job(id=JOB, status="done").to_record()
    del record["chords"], record["chords_reason"]
    back = Job.from_record(record)
    assert back.chords == "none" and back.chords_reason is None


def test_a_detection_registers_its_process_under_its_own_name():
    # POST /api/jobs/{id}/cancel finds the worker by this name.
    assert "chords" in typing.get_args(registry.Operation)
