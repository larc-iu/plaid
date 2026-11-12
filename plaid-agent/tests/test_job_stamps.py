"""An unattended job's writes are machine proposals, never verified work.

An approval's verified stamp is a person's: they looked at the card and
pressed Approve as verified. A job has no approval, so what it writes is
machine-unverified with the job named in provDetail (SPEC 6.4), and a person
reviews it later as any service's output. The mode is asked for by name, and
a write without the job's id is refused before anything is stamped, so a job
can never fall through to the verified default.
"""

import pytest

from fixtures import FakeClient, fake_ws

from plaid_agent.core.plan import STAMP_MODES, Stamps
from plaid_agent.igt.plan import execute_plan
from plaid_agent.igt.toolkit import call_tool

SOURCE = 'service:igt:job:glm-5.3-flash'
DETAIL = {'model': 'openai/glm-5.3-flash', 'version': '0.0.0+abc', 'job': 'J1'}


def test_machine_is_a_stamp_mode_of_its_own():
    assert 'machine' in STAMP_MODES
    s = Stamps('machine', SOURCE, detail=DETAIL)
    assert s.stamp() == {'prov': 'inferred', 'provSource': SOURCE, 'provDetail': DETAIL}
    restamp = s.restamp()
    assert restamp['prov'] == 'inferred' and restamp['provConfirmed'] is None and restamp['provProb'] is None
    assert s.confirm(False) is None and s.confirm(True) is None, 'a machine writer reviews nothing'


def test_a_machine_write_must_name_its_job():
    with pytest.raises(ValueError, match='job'):
        Stamps('machine', SOURCE, detail={'model': 'm', 'version': 'v'})
    with pytest.raises(ValueError, match='job'):
        Stamps('machine', SOURCE)


def test_an_analysis_written_in_machine_mode_is_unverified_with_the_job_named():
    ws = fake_ws(FakeClient())
    call_tool(ws, 'set_analysis', {'document': 'Text 1', 'ref': 's1.w3', 'morphemes': [
        {'form': 'aku', 'type': 'stem', 'fields': {'Morph Gloss': 'see'}},
        {'form': 'na', 'type': 'suffix', 'fields': {'Morph Gloss': 'PST'}}]})
    call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1.w3'], 'field': 'Gloss', 'value': 'saw'})
    assert ws.ops
    c = ws.client
    c.calls.clear()
    execute_plan(c, ws.plan_payload()['ops'], source=SOURCE, label='Assistant job: analyses', project=ws.project,
                 stamp_mode='machine', detail=DETAIL)
    stamped = [md for md in _metadata_written(c) if md and 'prov' in md]
    assert stamped, 'the writes carry provenance'
    for md in stamped:
        assert md['prov'] == 'inferred' and md['provSource'] == SOURCE
        assert md['provDetail']['job'] == 'J1'
        assert 'provConfirmed' not in md


def _metadata_written(c):
    """Every metadata map the run sent on a create."""
    out = []
    for name in ('spans.create', 'tokens.create', 'vocab_links.create', 'vocab_items.create'):
        for p in c.payloads(name):
            for a in list(p.get('args') or []) + list((p.get('kwargs') or {}).values()):
                if isinstance(a, dict):
                    out.append(a)
    for name in ('spans.bulk_create', 'tokens.bulk_create'):
        for payload in c.payloads(name):
            for entry in payload if isinstance(payload, list) else []:
                out.append(entry.get('metadata'))
    return out
