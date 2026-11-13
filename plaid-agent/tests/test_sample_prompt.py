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


def test_the_igt_job_snapshot_is_current():
    path = sample_prompt.job_out()
    assert os.path.exists(path)
    with io.open(path, encoding='utf-8') as fh:
        assert fh.read() == sample_prompt.render_job(), REGENERATE.format('IGT job')


def test_the_umr_snapshot_is_current():
    _check('umr')


def test_the_packaged_igt_guide_is_the_apps():
    """The copy an install without plaid-igt's sources answers app_guide from
    (R2-DICT-6, R2-TEST-13). In a checkout every test reads the repository's
    guide, so only this says the copy fell behind."""
    import pytest
    from plaid_agent.igt.guide import PACKAGED_GUIDE, REPO_GUIDE
    if not REPO_GUIDE.is_file():
        pytest.skip('no plaid-igt checkout beside the package')
    assert PACKAGED_GUIDE.read_bytes() == REPO_GUIDE.read_bytes(), (
        'The packaged igt guide differs from plaid-igt/docs/igt-guide.adoc. Run `bb sample-prompts` '
        '(from the repo root) in the same change as the guide edit.')


def test_the_packaged_job_section_headings_are_the_apps():
    """The job page's headings of a report's sections, which read_job names
    sections by (JD's point 3): one mapping, copied into the package."""
    import pytest
    from plaid_agent.igt.jobread import PACKAGED_SECTIONS, REPO_SECTIONS
    if not REPO_SECTIONS.is_file():
        pytest.skip('no plaid-igt checkout beside the package')
    assert PACKAGED_SECTIONS.read_bytes() == REPO_SECTIONS.read_bytes(), (
        'The packaged job section headings differ from plaid-igt\'s jobSections.json. Run `bb sample-prompts`.')
