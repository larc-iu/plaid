"""One definition of a job's "changes" (RPF-A3), what its text edits did to
the words (RPF-A8), and the worker's fixed top line (the owner's R4).

The report's ``changes`` counts each change the job wrote once, and
``changes_parts`` splits exactly that number by what each change is, so every
screen can say what it counts. A retype counts the words it adds and the
existing tokens, punctuation included, it changes or removes (RP-6: a quote
mark deleted while words were inserted). The report's ``notice`` says, in the
worker's own words, what the job changed of people's work and of the text."""

from types import SimpleNamespace

import pytest

from fixtures import FakeClient
from job_fixtures import JobClient, Model, call, document, reply, runner, start, targets_named, text_edits, use

from plaid_agent.core.job import notice, run_job
from plaid_agent.igt import jobapply
from plaid_agent.igt import plan as igt_plan
from plaid_agent.igt.project import load_project
from plaid_agent.igt.retyped import planned_words, retype_effects

J = 'JCP'


def _report(client):
    return client.jobs.rows[J]['report']


def test_changes_parts_split_the_changes_by_kind(monkeypatch):
    """An analysis and a value: two changes, one of each kind, in the totals,
    the document's counts and the piece's row alike."""
    def answer(asked, n, kwargs):
        if n > 1 or not targets_named(asked):
            return reply('Done.')
        return reply(calls=[
            call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1', 'morphemes': [
                {'form': 'ka', 'type': 'stem', 'fields': {'Morph Gloss': 'go'}}]}),
            call(2, 'set_field', {'document': 'Story', 'refs': ['s1.w2'], 'values': {'Gloss': 'x'}})])
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka', 'ta']}])})
    job = start(client, id=J, fills=('segmentation', 'sl-mgloss', 'sl-gloss'))
    use(monkeypatch, Model(answer))
    assert run_job(job, runner(job))['state'] == 'done'
    report = _report(client)
    parts = [{'kind': 'values', 'n': 1}, {'kind': 'analyses', 'n': 1}]
    assert report['totals']['changes'] == 2 and report['totals']['changes_parts'] == parts
    assert report['documents'][0]['counts']['changes_parts'] == parts
    rows = [p['piece'] for p in client.jobs.pieces(J) if 'document' in p['piece']]
    assert [r['changes_parts'] for r in rows] == [[{'kind': 'values', 'n': 1}, {'kind': 'analyses', 'n': 1}]]
    assert report['notice'] is None, 'nothing people wrote and nothing of the text was changed'


@pytest.mark.parametrize('kind,part', [
    ('set_span', 'values'), ('set_orthography', 'values'), ('set_analysis', 'analyses'),
    ('discard_analysis', 'analyses'), ('set_morpheme_form', 'analyses'), ('set_morph_type', 'analyses'),
    ('link', 'links'), ('link_phrase', 'links'), ('unlink', 'links'), ('create_entry', 'entries'),
    ('rename_entry', 'entries'), ('merge_entries', 'entries'), ('delete_entry', 'entries'),
    ('edit_text', 'text'), ('respell', 'text'), ('delete_sentence', 'text'), ('split_word', 'text'),
    ('add_comment', 'other'),
])
def test_every_kind_a_job_applies_is_one_part(kind, part):
    assert jobapply.change_kind({'kind': kind}) == part


def test_every_applied_kind_has_a_part_of_its_own_or_other():
    assert {jobapply.change_kind({'kind': k}) for k in jobapply.APPLIED_KINDS} <= {
        'values', 'analyses', 'links', 'entries', 'text', 'other'}
    assert [k for k in jobapply.APPLIED_KINDS if jobapply.change_kind({'kind': k}) == 'other'] == ['add_comment']


# --- A8: what a retype did to the words -----------------------------------------------------------

def _sentence(body):
    """The words and every token of ``body`` (one sentence at 0) as the word
    layer holds them: runs of letters are words, each punctuation run a
    token of its own."""
    import re
    tokens = [(m.start(), m.end()) for m in re.finditer(r'\S+', body)]
    words = [SimpleNamespace(id=f'w{i}', begin=b, end=e, surface=body[b:e])
             for i, (b, e) in enumerate(tokens) if any(c.isalnum() for c in body[b:e])]
    return words, tokens


def test_a_retype_that_only_inserts_changes_no_existing_token():
    project = load_project(FakeClient(), 'p1')
    body = 'sc tqmc kx naope .'
    words, tokens = _sentence(body)
    new = 'sc zz tqmc kx zz naope .'
    planned = planned_words(project, body, words, 0, body, new, tokens)
    assert retype_effects(project, body, words, 0, body, new, tokens, planned) == (2, 0)


def test_rp6_a_retype_that_deletes_a_quote_mark_counts_it():
    """RP-6: inserting a word, the retype also deleted the opening quote and
    trimmed the closing one from ".”": two existing tokens changed or
    removed, one word added."""
    project = load_project(FakeClient(), 'p1')
    body = 'kx , “ Mrlxnge tqetu .”'
    words, tokens = _sentence(body)
    new = 'kx , " zz Mrlxnge tqetu .'
    planned = planned_words(project, body, words, 0, body, new, tokens)
    assert retype_effects(project, body, words, 0, body, new, tokens, planned) == (1, 2)
    assert retype_effects(project, body, words, 0, body, new, tokens, None) == (1, 2), \
        'the same when its words cannot be numbered'


def test_a_respelled_word_is_a_changed_token():
    project = load_project(FakeClient(), 'p1')
    body = 'ka ta .'
    words, tokens = _sentence(body)
    assert retype_effects(project, body, words, 0, body, 'ka tax .', tokens, None) == (0, 1)


@pytest.mark.parametrize('op,effects', [
    ({'kind': 'edit_text', 'words_added': 3, 'tokens_changed': 1}, (3, 1)),
    ({'kind': 'respell'}, (0, 1)), ({'kind': 'delete_word'}, (0, 1)), ({'kind': 'split_word'}, (1, 1)),
    ({'kind': 'merge_words', 'other_ids': ['a', 'b']}, (0, 3)),
    ({'kind': 'delete_sentence', 'word_ids': ['a', 'b', 'c']}, (0, 3)),
    ({'kind': 'split_sentence'}, (0, 0)), ({'kind': 'set_span'}, (0, 0)),
])
def test_text_effects_by_op(op, effects):
    assert jobapply.text_effects(op) == effects


@pytest.fixture
def _edits(monkeypatch):
    text_edits(monkeypatch)
    monkeypatch.setattr(igt_plan, '_composed_as', lambda body, stored: (body, lambda p: p))


def test_a_jobs_retype_is_counted_in_its_report_and_its_notice(monkeypatch, _edits):
    def answer(asked, n, kwargs):
        if 'Instructions from' not in asked or n > 1:
            return reply('Retyped s1.')
        return reply(calls=[call(1, 'retype_sentence', {'document': 'Story', 'ref': 's1', 'text': 'ka tax zu.'})])
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka', 'ta']}])})
    client.texts.edit = lambda *a, **kw: client.record('texts.edit', {'args': a, 'kwargs': kw})
    job = start(client, 'Do as asked.', id=J, plan='document', edits_text=True)
    use(monkeypatch, Model(answer))
    run_job(job, runner(job))
    report = _report(client)
    totals = report['totals']
    assert (totals['words_added'], totals['tokens_changed'], totals['text_changes']) == (1, 1, 1)
    assert report['documents'][0]['counts']['words_added'] == 1
    assert totals['changes_parts'] == [{'kind': 'text', 'n': 1}]
    assert report['notice'] == 'Text: 1 word added, 1 existing word or punctuation mark changed or removed.'


# --- R4: the worker's fixed top line ------------------------------------------------------------

@pytest.mark.parametrize('totals,line', [
    ({}, None),
    ({'changes': 4}, None),
    ({'peoples_values_changed': 33}, "People's work: 33 values, morphemes or links people wrote were changed or "
                                     "removed. What the job wrote in their place is unverified."),
    ({'peoples_values_changed': 1}, "People's work: 1 value, morpheme or link people wrote was changed or removed. "
                                    "What the job wrote in their place is unverified."),
    ({'text_changes': 14, 'words_added': 25, 'tokens_changed': 2},
     'Text: 25 words added, 2 existing words or punctuation marks changed or removed.'),
    ({'text_changes': 14, 'words_added': 25}, 'Text: 25 words added.'),
    ({'text_changes': 2}, 'Text: 2 text edits, no word added, changed or removed.'),
    ({'peoples_values_changed': 2, 'text_changes': 1, 'tokens_changed': 1},
     "People's work: 2 values, morphemes or links people wrote were changed or removed. What the job wrote in "
     "their place is unverified. Text: 1 existing word or punctuation mark changed or removed."),
])
def test_the_notice_says_what_was_changed_of_peoples_work_and_the_text(totals, line):
    assert notice(totals) == line


# --- REV-RPF-W-4: people's work a text edit took away -------------------------------------------

def _human(form, gloss='go', word_gloss=None):
    d = {'form': form, 'morphs': [(form, gloss)], 'who': 'human'}
    if word_gloss:
        d['gloss'] = (word_gloss, 'human')
    return d


@pytest.mark.parametrize('calls,people', [
    # ta typed over whole: its token goes with the person's morpheme and its
    # gloss (two, as the Changes view counts them, REV-RPF2-1).
    ([('retype_sentence', {'document': 'Story', 'ref': 's1', 'text': 'ka bolo.'})], 2),
    # ta deleted.
    ([('delete_word', {'document': 'Story', 'refs': ['s1.w2']})], 2),
    # ta respelled keeps its token and what is on it: nothing of people's lost.
    ([('retype_sentence', {'document': 'Story', 'ref': 's1', 'text': 'ka tax.'})], 0),
    # a word inserted beside it: nothing lost.
    ([('retype_sentence', {'document': 'Story', 'ref': 's1', 'text': 'ka zu ta.'})], 0),
])
def test_peoples_work_on_a_word_a_text_edit_removes_is_counted_as_peoples(monkeypatch, _edits, calls, people):
    """A person's analysis on a word the job deleted or typed over whole is
    people's work the job removed (REV-RPF-W-4): one change to what people
    wrote, by the provenance of what the text op removes in the document read
    under the lock, so the notice says so beside the Text sentence."""
    def answer(asked, n, kwargs):
        if 'Instructions from' not in asked or n > 1:
            return reply('Done.')
        return reply(calls=[call(i + 1, t, a) for i, (t, a) in enumerate(calls)])
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka', _human('ta')]}])})
    client.texts.edit = lambda *a, **kw: client.record('texts.edit', {'args': a, 'kwargs': kw})
    job = start(client, 'Do as asked.', id=J, plan='document', edits_text=True)
    use(monkeypatch, Model(answer))
    run_job(job, runner(job))
    report = _report(client)
    assert report['totals']['peoples_values_changed'] == people, report['totals']
    assert report['documents'][0]['counts'].get('peoples_values_changed', 0) == people
    assert (report['notice'] or '').startswith(f"People's work: {people} values") == (people > 0), report['notice']


def test_rev_rpf2_1_each_persons_value_morpheme_and_link_a_retype_removes_is_counted(monkeypatch, _edits):
    """The reviewer's Story Q: "pa ro" retyped "pa" takes away ro with a
    person's morpheme, its Gloss and a word Gloss; "sc tqmc" retyped "sc bolo"
    types over tqmc with a person's morpheme and Gloss. The Changes view reads
    "5 replaced a person's value" (3 values and 2 morphemes): the report's
    count of what people wrote changed or removed is 5 too, not 2 words."""
    def answer(asked, n, kwargs):
        if 'Instructions from' not in asked or n > 1:
            return reply('Done.')
        return reply(calls=[call(1, 'retype_sentence', {'document': 'Story', 'ref': 's1', 'text': 'pa.'}),
                            call(2, 'retype_sentence', {'document': 'Story', 'ref': 's2', 'text': 'sc bolo.'})])
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['pa', _human('ro', 'come', 'arrive')]},
                                                       {'words': ['sc', _human('tqmc', 'he')]}])})
    client.texts.edit = lambda *a, **kw: client.record('texts.edit', {'args': a, 'kwargs': kw})
    job = start(client, 'Fix the text.', id=J, plan='document', edits_text=True)
    use(monkeypatch, Model(answer))
    run_job(job, runner(job))
    report = _report(client)
    assert report['totals']['peoples_values_changed'] == 5, report['totals']
    assert report['notice'].startswith("People's work: 5 values, morphemes or links people wrote were changed or "
                                       "removed."), report['notice']


def test_an_analysis_replacing_a_persons_counts_each_morpheme_value_and_link_it_replaces():
    """A set_analysis over a word holding a person's analysis replaces each of
    its morphemes and their values and links, as the Changes view counts them
    (REV-RPF2-1), not one per word."""
    from fixtures import FakeClient
    from plaid_agent.igt.job import replaces_people
    client = JobClient({'d1': document('d1', 'Story', [{'words': [_human('ro', 'come')]}])})
    project = load_project(client, 'p1')
    from plaid_agent.igt.project import parse_document
    doc = parse_document(client.documents.get('d1', include_body=True), project)
    w = doc.sentences[0].words[0]
    op = {'kind': 'set_analysis', 'word_id': w.id, 'morphemes': [{'form': 'r'}, {'form': 'o'}]}
    assert replaces_people(op, doc, project) == 2, 'the morpheme and its gloss'
