"""The heartbeat's line always fits core's 300 UTF-16 units (D7 of the job
review 2026-11-18): a document whose name is long, or written in a script
whose letters take two units each (Adlam), is never a line core refuses,
which would refuse every heartbeat after it and lapse the lease while the
worker works."""

import pytest

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.core.job import error_line, fit_line


def units(text):
    return len(text.encode('utf-16-le')) // 2


ADLAM = '\U0001E900'


def _analyse(asked, n, kwargs):
    if n == 1:
        doc = asked.split('"')[1]
        return reply(calls=[call(1, 'set_analysis', {'document': doc, 'ref': 's1.w1', 'morphemes': [{'form': 'blank'}]})])
    return reply('Done.')


@pytest.mark.parametrize('name', ['N' * 400, ADLAM * 160])
def test_every_heartbeat_of_a_long_named_document_is_taken(monkeypatch, name):
    client = JobClient({'d1': document('d1', name, [{'words': ['blank']}]),
                        'd2': document('d2', 'Two', [{'words': ['blank']}])})
    job = start(client)
    use(monkeypatch, Model(_analyse))
    refused = []
    real = client.jobs.heartbeat

    def heartbeat(*a, **kw):
        try:
            return real(*a, **kw)
        except Exception as e:  # noqa: BLE001
            refused.append(e)
            raise
    client.jobs.heartbeat = heartbeat
    assert runner(job).document('d1') == 'done'
    assert not refused, refused
    sent = [c[1].get('message') for c in client.jobs.calls if c[0] == 'heartbeat' and c[1].get('message')]
    assert sent and all(units(m) <= 300 for m in sent)
    assert any(m.startswith(name[:20]) for m in sent)


def test_a_line_is_cut_to_300_units_with_an_ellipsis():
    assert fit_line('short') == 'short'
    cut = fit_line(ADLAM * 200)
    assert units(cut) <= 300 and cut.endswith('…') and cut.startswith(ADLAM)
    assert units(error_line(RuntimeError(ADLAM * 200))) <= 300
