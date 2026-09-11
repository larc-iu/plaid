"""The two prompt snapshots say what the model is actually sent.

They are documentation, which is exactly why they rot: a tool changes and the
file keeps describing the tool as it was. Item 15.4 asks for them to be
regenerated in the same change as any tool edit, and nothing enforced that, so
UD's snapshot fell four tools behind and IGT's one description behind.

    python tests/ud_sample_prompt.py
    python tests/sample_prompt.py
"""

import io
import os

import sample_prompt
import ud_sample_prompt

REGENERATE = 'Run `python tests/{}.py` in the same change as the tool edit.'


def _current(module) -> str:
    with io.open(module.OUT, encoding='utf-8') as fh:
        return fh.read()


def test_the_ud_snapshot_is_current():
    assert os.path.exists(ud_sample_prompt.OUT)
    assert _current(ud_sample_prompt) == ud_sample_prompt.render(), \
        REGENERATE.format('ud_sample_prompt')


def test_the_igt_snapshot_is_current():
    assert os.path.exists(sample_prompt.OUT)
    assert _current(sample_prompt) == sample_prompt.render(), \
        REGENERATE.format('sample_prompt')
