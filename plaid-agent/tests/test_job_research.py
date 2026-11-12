"""A job's writes are machine work in the study's dataset (SPEC 10): its
operation kind is followed by default, its actor class is machine, and the
dataset's documentation says so."""

import pathlib

from plaid_agent.research import fates

DATASET = pathlib.Path(fates.__file__).with_name('DATASET.md')


def test_a_job_is_a_machine_actor_followed_by_default():
    assert fates.ACTOR['job'] == 'machine'
    assert 'job' in fates.DEFAULT_TRACK


def test_the_dataset_names_the_kind():
    assert '- `job`: an unattended assistant job' in DATASET.read_text()
