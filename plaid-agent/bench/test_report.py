"""report.py's "would time out in production" flag, against the smoke runs.

    $PLAID_AGENT_PYTHON -m pytest -q test_report.py

The flag is a silence over 120 s (production's timeout resets on every
streamed chunk), not a long call. smoke-2 has no call over 120 s, so nothing
is flagged. In a copy of it, one umr call silent for 130.5 s is flagged, for
umr only, a call silent for exactly 120 s is not, and a 300 s call that kept
streaming is not. A call from an older gate log (total time only) over 120 s
that streamed is "not measured", and one that streamed nothing is flagged.
"""
import json
from pathlib import Path

import pytest

import report

SMOKE = 'smoke-2'


def _copy(tmp_path):
    """A stamp shaped like smoke-2 (the smoke runs, since removed): one run
    per app, each with a gate log from the older gate (total time only)."""
    d = tmp_path / SMOKE
    for app, task in (('igt', 'igt-smoke-gloss'), ('ud', 'ud-smoke-upos'), ('umr', 'umr-smoke-attr')):
        run = d / task / 'glm-5.2' / '1'
        run.mkdir(parents=True)
        (run / 'score.json').write_text(json.dumps({
            'app': app, 'task': task, 'model': 'glm-5.2', 'rep': 1, 'pass': True, 'turn_ends': ['answered'],
            'request_errors': [], 'endpoint_errors': [], 'tool_calls': 2, 'failed_calls': 0, 'turn_wall_s': 20.0}))
        (run / 'gate.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in [
            {'at': 1.0, 'stream': False, 'status': 200, 'upstream_s': 2.0, 'bytes': 900},
            {'at': 2.0, 'stream': True, 'status': 200, 'upstream_s': 9.0, 'bytes': 40000}]))
    return d


@pytest.fixture(autouse=True)
def _runs(tmp_path, monkeypatch):
    _copy(tmp_path)
    monkeypatch.setattr(report, 'RUNS', tmp_path)


def _set_last(gate: Path, **fields):
    rows = [json.loads(x) for x in gate.read_text().splitlines() if x.strip()]
    rows[-1].update(fields)
    gate.write_text(''.join(json.dumps(r) + '\n' for r in rows))


def _by_app(text):
    """app -> the last cell of its row in the 'By app and model' table."""
    part = text.split('## By app and model', 1)[1].split('\n## ', 1)[0]
    rows = [r.strip('|').split('|') for r in part.splitlines() if r.startswith('| ') and 'glm' in r]
    return {r[0].strip(): r[-1].strip() for r in rows}


def test_smoke_runs_are_not_flagged():
    text = report.one(SMOKE)
    assert 'would time out in production' in text
    assert '## Would time out in production' not in text
    assert set(_by_app(text).values()) == {'0'}


def test_a_silent_call_flags_its_run_and_app(tmp_path, monkeypatch):
    d = tmp_path / SMOKE
    _set_last(d / 'umr-smoke-attr/glm-5.2/1/gate.jsonl', upstream_s=200.0, first_chunk_s=0.4, max_gap_s=130.5)
    _set_last(d / 'igt-smoke-gloss/glm-5.2/1/gate.jsonl', upstream_s=150.0, first_chunk_s=120, max_gap_s=2.0)
    _set_last(d / 'ud-smoke-upos/glm-5.2/1/gate.jsonl', upstream_s=300.0, first_chunk_s=0.3, max_gap_s=0.5)
    text = report.one(SMOKE)
    assert _by_app(text) == {'igt': '0', 'ud': '0', 'umr': '1'}
    listed = text.split('## Would time out in production', 1)[1].split('\n## ', 1)[0]
    assert 'umr-smoke-attr' in listed and '130.5' in listed
    assert 'igt-smoke-gloss' not in listed and 'ud-smoke-upos' not in listed
    assert '## Calls over the limit whose silence was not logged' not in text
    diff = report.two(SMOKE, SMOKE)
    assert '| umr-smoke-attr | glm-5.2 |' in diff and '| 1 | 1 | 0 | 0 |' in diff.rstrip().splitlines()[-1]


def test_a_slow_first_chunk_flags_its_run(tmp_path, monkeypatch):
    d = tmp_path / SMOKE
    _set_last(d / 'igt-smoke-gloss/glm-5.2/1/gate.jsonl', upstream_s=125.0, first_chunk_s=121.0, max_gap_s=3.0)
    assert _by_app(report.one(SMOKE))['igt'] == '1'


def test_an_old_log_is_judged_only_where_it_can_be(tmp_path, monkeypatch):
    d = tmp_path / SMOKE
    for app in ('umr-smoke-attr', 'igt-smoke-gloss', 'ud-smoke-upos'):
        assert 'max_gap_s' not in (d / f'{app}/glm-5.2/1/gate.jsonl').read_text()  # smoke-2 is an old log
    _set_last(d / 'umr-smoke-attr/glm-5.2/1/gate.jsonl', upstream_s=240.0)  # streamed: cannot tell
    _set_last(d / 'igt-smoke-gloss/glm-5.2/1/gate.jsonl', upstream_s=900.0, bytes=0)  # nothing came: silent
    _set_last(d / 'ud-smoke-upos/glm-5.2/1/gate.jsonl', upstream_s=119.0)  # under the limit in total
    text = report.one(SMOKE)
    assert _by_app(text) == {'igt': '1', 'ud': '0', 'umr': '0 (+1 not measured)'}
    unknown = text.split('## Calls over the limit whose silence was not logged', 1)[1].split('\n## ', 1)[0]
    assert 'umr-smoke-attr' in unknown and '240.0' in unknown and 'igt-smoke-gloss' not in unknown


def test_the_tasks_table_lists_tasks(tmp_path, monkeypatch):
    text = report.one(SMOKE)
    part = text.split('## Tasks', 1)[1]
    assert part.splitlines()[2].startswith('| app | task | model | passed | infra |')
    assert '| umr | umr-smoke-attr | glm-5.2 | 1/1 | 0 |' in part


def test_an_infra_run_is_listed_apart_and_not_counted(tmp_path, monkeypatch):
    d = tmp_path / SMOKE
    run = d / 'umr-smoke-attr/glm-5.2/1'
    s = json.loads((run / 'score.json').read_text())
    s.update({'pass': False, 'turn_ends': ['failed'], 'request_errors': ['RuntimeError: The model could not answer.']})
    s.pop('infra', None)
    s.pop('endpoint_errors', None)
    (run / 'score.json').write_text(json.dumps(s))
    with open(run / 'gate.jsonl', 'a') as f:  # an old log: no infra field, judged by status
        f.write(json.dumps({'at': 1e10, 'status': 429, 'error': 'capacity', 'upstream_s': 0.1}) + '\n')
    text = report.one(SMOKE)
    part = text.split('## By app and model', 1)[1].split('\n## ', 1)[0]
    umr = next(r for r in part.splitlines() if r.startswith('| umr '))
    assert '| 0/0 | 1 |' in umr  # not a failure of the assistant
    listed = text.split('## Infra runs (not counted)', 1)[1].split('\n## ', 1)[0]
    assert 'umr-smoke-attr' in listed and 'rate_limited' in listed
    # an ordinary failure (turns ended normally) stays the assistant's
    s['turn_ends'], s['request_errors'] = ['answered'], []
    (run / 'score.json').write_text(json.dumps(s))
    text = report.one(SMOKE)
    assert '## Infra runs' not in text
    part = text.split('## By app and model', 1)[1].split('\n## ', 1)[0]
    assert '| 0/1 | 0 |' in next(r for r in part.splitlines() if r.startswith('| umr '))


def test_storage_reads_the_record_the_turns_and_the_extract(tmp_path):
    plan = {'id': 'p', 'changes': [{'label': 'Ж'}], 'proposed_count': 2}
    (tmp_path / 'record.json').write_text(json.dumps(
        {'conversation': {'display': [{'kind': 'assistant', 'plan': plan}, {'kind': 'user'}]}}))
    (tmp_path / 'turns.json').write_text(json.dumps([
        {'kind': 'turn', 'plan_bytes': 900, 'plan_changes': 3}, {'kind': 'turn', 'plan_bytes': 400, 'plan_changes': 1},
        {'kind': 'approve', 'wall_s': 1.5}]))
    (tmp_path / 'extract').mkdir()
    (tmp_path / 'extract' / 'conversations.jsonl').write_text(
        json.dumps({'record_bytes': 5000, 'tool_results_dropped': 2, 'rounds_bytes': 700}) + '\n')
    st = report.storage(tmp_path)
    # core escapes non-ASCII: Ж is six bytes, not two
    assert st['settled_bytes'] == report.core_bytes(plan) and '\\u0416' in json.dumps(plan)
    assert st == {'record_bytes': 5000, 'dropped': 2, 'rounds_bytes': 700, 'undecided_bytes': 900, 'undecided_changes': 3,
                  'settled_bytes': st['settled_bytes'], 'settled_changes': 2, 'approve_s': 1.5,
                  'approve_first_s': None, 'send_first_s': None}
    assert report.per_change(900, 3) == 300
