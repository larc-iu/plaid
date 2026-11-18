"""After a whole-selection piece nothing more is worked for want of reading
or for what is empty (the lead's ruling after RP4-5, replacing RPF3-A's walk
where empty: "Gloss" being a fill walked 30 unglossed sentences of two
documents that had nothing to do with the request). What stays: a write put
off because a person was editing is taken again, a sentence a person changed
during the piece is taken again, and the piece after a text edit. Whatever the
job fills that is still empty is in Left blank. Every document the step
covered ends done, its row's ``counts.one_step`` true, and the report's top
line says the step and how many it changed."""


from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from fixtures import MGLOSS
from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job
import pytest

# Each test runs as scripted and with set_field and link_entry in the items form (BRIEF SP item 2).
pytestmark = pytest.mark.usefixtures('both_forms')


J = 'JAS'
OLD, NEW = 'be.3ᴀᴜɢII', 'be.3AUGII'


def _doc(i, gloss):
    """Story i: one sentence, nidr glossed ``gloss`` and ka glossed go, both
    a person's."""
    return document(f'd{i}', f'Story {i}', [{'words': [('nidr', [('nidr', gloss)], 'human'),
                                                       ('ka', [('ka', 'go')], 'human')]}])


def _renamed(i):
    """Story i with nidr's gloss renamed by the job."""
    return document(f'd{i}', f'Story {i}', [{'words': [('nidr', [('nidr', NEW)], {'token': 'human', 'span': J,
                                                                                    'link': 'human'}),
                                                       ('ka', [('ka', 'go')], 'human')]}], version=2)


def _applying(monkeypatch, client):
    """Each write leaves its document renamed for the reads after it."""
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        out = real(c, ops, **kw)
        for o in ops:
            for v in o.values():
                if isinstance(v, str) and v.startswith('sp-d'):
                    i = int(v[len('sp-d'):].split('-')[0])
                    client.after_write[f'd{i}'] = _renamed(i)
        return out
    monkeypatch.setattr(igt_job, 'execute_plan', execute)


def _pieces(model):
    return [c['asked'] for c in model.calls if c['n'] == 1]


def test_nothing_empty_the_rename_makes_no_call_after_its_piece(monkeypatch):
    """The rename's shape: 45 documents, nothing empty, the old gloss in 24.
    The piece renames by reference, reading nothing. No model call follows
    it; every document is done in the one step; the counts and the top line
    say 45 documents and 24 changed."""
    n, renamed = 45, set(range(1, 25))
    client = JobClient({f'd{i}': _doc(i, OLD if i in renamed else 'be') for i in range(1, n + 1)})
    _applying(monkeypatch, client)
    job = start(client, f'Change the gloss {OLD} to {NEW} everywhere.', id=J, plan='selection', fills=(MGLOSS,))

    def answer(asked, k, kwargs):
        if k == 1:
            return reply(calls=[call(i, 'set_field', {'document': f'Story {i}', 'refs': ['s1.w1.m1'],
                                                      'field': 'Morph Gloss', 'value': NEW}) for i in sorted(renamed)])
        return reply(f'Renamed {OLD} to {NEW} in 24 documents.')
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert len(_pieces(model)) == 1
    report = finished['report']
    assert report['plan']['fallback'] == []
    docs = {d['name']: d for d in report['documents']}
    assert all(d['state'] == 'done' and d['counts'].get(igt_job.ONE_STEP) is True for d in docs.values())
    assert {name for name, d in docs.items() if d['counts']['changes']} == {f'Story {i}' for i in renamed}
    assert report['totals']['changes'] == 24 and report['totals']['documents_done'] == n
    # RP4-4 finding 1: "Documents done 0" beside 45 rows reading Done.
    assert igt_job.document_counts(report)['done'] == 45
    assert igt_job.document_counts(report)['changed'] == 24
    assert report['notice'].endswith('The job worked on all 45 documents in one step and changed 24 of them. It did '
                                     'not read every sentence.'), report['notice']


def test_empties_in_documents_it_wrote_in_make_no_call_after_its_piece(monkeypatch):
    """Story 1 holds the old gloss and an unglossed word. The piece renames
    by reference. Nothing is walked for the empty: it is in Left blank."""
    client = JobClient({'d1': document('d1', 'Story 1', [{'words': [('nidr', [('nidr', OLD)], 'human'), 'sa']}])})
    client.after_write['d1'] = document('d1', 'Story 1', [{'words': [
        ('nidr', [('nidr', NEW)], {'token': 'human', 'span': J, 'link': 'human'}), 'sa']}], version=2)
    job = start(client, 'Rename it.', id=J, plan='selection', fills=('segmentation', MGLOSS))

    def answer(asked, k, kwargs):
        if k == 1:
            return reply(calls=[call(1, 'set_field', {'document': 'Story 1', 'refs': ['s1.w1.m1'],
                                                      'field': 'Morph Gloss', 'value': NEW})])
        return reply('Renamed.')
    model = use(monkeypatch, Model(answer))
    report = run_job(job, runner(job))['report']
    assert len(_pieces(model)) == 1
    (d,) = report['documents']
    assert d['state'] == 'done' and d['counts'].get(igt_job.ONE_STEP) is True
    # The unglossed word is in Left blank, in the sentence the job wrote in.
    assert [e['ref'] for e in d.get('left') or []] == ['s1.w2'], (d.get('left'), d['counts'].get('blank'))
    assert report['notice'].endswith('The job worked on its one document in one step and changed it. It did not '
                                     'read every sentence.'), report['notice']


def test_empties_in_documents_it_never_opened_make_no_call_after_its_piece(monkeypatch):
    """RP4-5's shape: Story 2, never read and unglossed, has nothing to do
    with the request. It is not walked; what is empty there is in Left
    blank."""
    client = JobClient({'d1': _doc(1, OLD),
                        'd2': document('d2', 'Story 2', [{'words': ['sa', 'ta']}, {'words': ['mo']}])})
    _applying(monkeypatch, client)
    job = start(client, 'Rename it.', id=J, plan='selection', fills=('segmentation', MGLOSS))
    lines = []

    def answer(asked, k, kwargs):
        lines.append(job.status.get('message'))
        if k == 1:
            return reply(calls=[call(1, 'set_field', {'document': 'Story 1', 'refs': ['s1.w1.m1'],
                                                      'field': 'Morph Gloss', 'value': NEW})])
        return reply('Renamed.')
    model = use(monkeypatch, Model(answer))
    report = run_job(job, runner(job))['report']
    assert len(_pieces(model)) == 1
    assert report['plan']['fallback'] == []
    docs = {d['name']: d for d in report['documents']}
    assert docs['Story 2']['state'] == 'done' and docs['Story 2']['counts'].get(igt_job.ONE_STEP) is True
    blank = {b['target']: b for b in docs['Story 2']['counts'].get('blank') or []}
    assert sum(sum(v for k, v in b.items() if isinstance(v, int)) for b in blank.values()) > 0, blank
    assert report['notice'].endswith('The job worked on all 2 documents in one step and changed 1 of them. It did '
                                     'not read every sentence.'), report['notice']
    # S2-3: the final context is told which documents the step did not read
    # all of, whose blanks it never saw, never that they were worked.
    lines = {ln.split('"')[1]: ln for ln in igt_job.summary_message(report).splitlines()
             if ln.startswith('- "Story ')}
    assert lines['Story 2'].startswith('- "Story 2": done in the one step, which did not read all of it'), lines
    assert 'over all the documents' not in igt_job.summary_message(report)
    assert 'in a document the one step did not read all of, also those in sentences it never read' in \
        igt_job.summary_message(report)


def test_a_check_makes_no_call_after_its_piece(monkeypatch):
    """A check whose piece read s1 of each of two three-sentence documents:
    nothing more is worked; it changed none."""
    three = [{'words': [('nidr', [('nidr', 'be')], 'human')]} for _ in range(3)]
    client = JobClient({'d1': document('d1', 'Story 1', three), 'd2': document('d2', 'Story 2', three)})
    job = start(client, 'List the glosses in small capitals. Change nothing.', id=J, plan='selection', fills=())

    def answer(asked, k, kwargs):
        if k == 1:
            return reply(calls=[call(i, 'read_document', {'document': f'Story {i}', 'from_sentence': 1,
                                                          'to_sentence': 1}) for i in (1, 2)])
        return reply('None.')
    model = use(monkeypatch, Model(answer))
    report = run_job(job, runner(job))['report']
    assert len(_pieces(model)) == 1
    assert report['notice'] == ('The job worked on all 2 documents in one step and changed none of them. It did not '
                                'read every sentence.'), report['notice']


def test_a_step_that_read_every_sentence_does_not_say_it_did_not(monkeypatch):
    """The second sentence of the line is said only where it is true."""
    client = JobClient({'d1': _doc(1, OLD), 'd2': document('d2', 'Story 2', [{'words': ['sa']}])})
    job = start(client, 'List the glosses in small capitals. Change nothing.', id=J, plan='selection', fills=())

    def answer(asked, k, kwargs):
        if k == 1:
            return reply(calls=[call(1, 'read_document', {'document': 'Story 1'}),
                                call(2, 'read_document', {'document': 'Story 2'})])
        return reply(f'One: {OLD} in Story 1.')
    model = use(monkeypatch, Model(answer))
    report = run_job(job, runner(job))['report']
    assert len(_pieces(model)) == 1
    assert [d['state'] for d in report['documents']] == ['done', 'done']
    assert report['notice'] == 'The job worked on all 2 documents in one step and changed none of them.', \
        report['notice']
    # S2-3: a document the step read all of is said done in it, no more.
    assert '- "Story 2": done in the one step\n' in igt_job.summary_message(report)
    assert 'did not read all of it' not in igt_job.summary_message(report)


def _sentences(n, blank_at=None):
    return [{'words': [('nidr', [('nidr', 'be')], 'human'),
                       'sa' if i == blank_at else ('ka', [('ka', 'go')], 'human')]} for i in range(1, n + 1)]


def test_the_piece_after_a_selections_text_edit_runs_and_nothing_is_walked_after_it(monkeypatch):
    """REV-RPF3-3 (the reviewer's a3): onlynew, a selection whose piece reads
    s1 of a 12-sentence Story 1 and inserts xosan there. The piece after the
    text edit glosses xosan, before the documents end in the one step:
    nothing is walked after it."""
    from job_fixtures import text_edits
    text_edits(monkeypatch)
    sents = _sentences(12)
    client = JobClient({'d1': document('d1', 'Story 1', sents), 'd2': _doc(2, 'be')})
    after = [{'words': [('nidr', [('nidr', 'be')], 'human'), 'xosan', ('ka', [('ka', 'go')], 'human')]}] + sents[1:]
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        if any(o['kind'] == 'edit_text' for o in ops):
            raw = document('d1', 'Story 1', after, version=5)
            words = raw['text_layers'][0]['token_layers'][1]['tokens']
            words[1]['id'], words[2]['id'] = 'd1-new', 'd1-s1w2'
            for m in raw['text_layers'][0]['token_layers'][2]['tokens']:
                m['id'] = m['id'].replace('d1-s1w3', 'd1-s1w2')
            client._holder('d1')['documents']['d1'] = raw
            return {}
        if any(o['kind'] == 'set_analysis' for o in ops):
            raw = document('d1', 'Story 1', [{'words': [('nidr', [('nidr', 'be')], 'human'),
                                                        ('xosan', [('xosan', 'good')], J),
                                                        ('ka', [('ka', 'go')], 'human')]}] + sents[1:], version=6)
            words = raw['text_layers'][0]['token_layers'][1]['tokens']
            words[1]['id'], words[2]['id'] = 'd1-new', 'd1-s1w2'
            for m in raw['text_layers'][0]['token_layers'][2]['tokens']:
                m['id'] = m['id'].replace('d1-s1w2m', 'd1-newm').replace('d1-s1w3', 'd1-s1w2')
            client._holder('d1')['documents']['d1'] = raw
            return {}
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    setup = {'fills': [{'id': 'segmentation', 'name': 'segmentation'}, {'id': MGLOSS, 'name': 'Morph Gloss'}],
             'text': True, 'conversation': 'c1', 'onlynew': True}
    job = start(client, 'Insert xosan after nidr in Story 1 s1 and gloss it.', id=J, plan='selection',
                fills=('segmentation', MGLOSS), setup=setup)
    kinds = []

    def answer(asked, k, kwargs):
        if 'Instructions from' not in asked:
            return reply('Done.')
        kind = ('sel' if 'Your piece: the whole selection above.' in asked
                else 'after' if igt_job.AFTER_TEXT_LINE in asked else 'walk')
        if k == 1:
            kinds.append(kind)
        if kind == 'sel':
            if k == 1:
                return reply(calls=[call(1, 'read_sentences', {'document': 'Story 1', 'refs': ['s1']}),
                                    call(2, 'retype_sentence', {'document': 'Story 1', 'ref': 's1',
                                                                'text': 'nidr xosan ka.'})])
            return reply('Inserted.')
        if kind == 'after' and k == 1:
            return reply(calls=[call(9, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w2 "xosan"', 'morphemes': [
                {'form': 'xosan', 'fields': {'Morph Gloss': 'good'}}]})])
        return reply('Nothing.')
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert kinds == ['sel', 'after'], kinds
    assert finished['report']['plan']['fallback'] == []
