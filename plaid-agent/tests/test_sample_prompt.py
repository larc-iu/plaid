"""The prompt snapshots say what the model is actually sent.

They are documentation, which is exactly why they rot: a tool changes and the
file keeps describing the tool as it was. Item 15.4 asks for them to be
regenerated in the same change as any tool edit, and nothing enforced that, so
UD's snapshot fell four tools behind and IGT's one description behind. One
test per app, because a parameterized one names the app only in the id and
this failure is read from the message.

    bb sample-prompts
"""

import io
import os

import sample_prompt
import ud_sample_prompt
import umr_sample_prompt

REGENERATE = ('The {} prompt snapshot is out of date. Run `bb sample-prompts` (from the repo root, '
              'with the assistant importable) in the same change as the tool or prompt edit.')


def _current(module) -> str:
    with io.open(module.OUT, encoding='utf-8') as fh:
        return fh.read()


def test_the_ud_snapshot_is_current():
    assert os.path.exists(ud_sample_prompt.OUT)
    assert _current(ud_sample_prompt) == ud_sample_prompt.render(), \
        REGENERATE.format('UD')


def test_the_igt_snapshot_is_current():
    assert os.path.exists(sample_prompt.OUT)
    assert _current(sample_prompt) == sample_prompt.render(), \
        REGENERATE.format('IGT')


def test_the_umr_snapshot_is_current():
    assert os.path.exists(umr_sample_prompt.OUT)
    assert _current(umr_sample_prompt) == umr_sample_prompt.render(), \
        REGENERATE.format('UMR')
