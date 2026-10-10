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

REGENERATE = ('The {} prompt snapshot is out of date. Run `bb sample-prompts` (from the repo root, '
              'with the assistant importable) in the same change as the tool or prompt edit.')


def _check(app: str) -> None:
    path = sample_prompt.out(app)
    assert os.path.exists(path)
    with io.open(path, encoding='utf-8') as fh:
        assert fh.read() == sample_prompt.render(app), REGENERATE.format(app.upper())


def test_the_ud_snapshot_is_current():
    _check('ud')


def test_the_igt_snapshot_is_current():
    _check('igt')


def test_the_umr_snapshot_is_current():
    _check('umr')
