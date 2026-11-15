"""The report says when a job changed what people wrote, and when it changed
the text (REV-DAY-S-3): each write's rows count the changes that change or
take away something people wrote, by its provenance in the document before
the write, and the changes to the text or its words and sentences, from the
worker's own ops, never from words. The report sums both per document and in
its totals."""

from collections import Counter

from fixtures import MGLOSS, TRANS
from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import Stretch
from plaid_agent.igt.project import load_project, parse_document

J = 'JPC'
# s1: a person's "gam" 'fish' and a machine's "ka" 'go', s2: blank "sa" with
# a person's translation.
SPEC = [{'words': [('gam', [('gam', 'fish')], 'human'), ('ka', [('ka', 'go')], 'svc')]},
        {'words': ['sa'], 'translation': ('See.', 'human')}]


def _write():
    client = JobClient({'d1': document('d1', 'Story', SPEC)})
    project = load_project(client, 'p1')
    doc = parse_document(client.documents.get('d1', include_body=True), project)
    return igt_job.Write('d1', '', Stretch(doc, project, doc.sentences, J), [], [], Counter(), doc)


def _gloss(word, value):
    return {'kind': 'set_span', 'layer_id': MGLOSS, 'token_id': f'd1-s1w{word}m1', 'span_id': f'sp-d1-s1w{word}m1',
            'value': value}


def _counted(ops):
    c = _write().of_people_and_text(ops)
    return c['peoples_values_changed'], c['text_changes']


def test_a_value_people_wrote_changed_or_cleared_counts():
    assert _counted([_gloss(1, 'net')]) == (1, 0)
    assert _counted([_gloss(1, '')]) == (1, 0)


def test_a_machine_value_changed_or_a_value_restated_does_not():
    assert _counted([_gloss(2, 'come')]) == (0, 0)
    assert _counted([_gloss(1, 'fish')]) == (0, 0)


def test_an_analysis_replaced_on_peoples_word_counts_and_on_a_blank_word_does_not():
    seg = {'kind': 'set_analysis', 'word_id': 'd1-s1w1', 'morphemes': [{'form': 'ga'}, {'form': 'm'}]}
    blank = {'kind': 'set_analysis', 'word_id': 'd1-s2w1', 'morphemes': [{'form': 'sa'}]}
    assert _counted([seg]) == (1, 0)
    assert _counted([blank]) == (0, 0)


def test_a_translation_people_wrote_replaced_counts():
    op = {'kind': 'set_span', 'layer_id': TRANS, 'token_id': 'd1-s2', 'span_id': 'sp-t-d1-s2', 'value': 'Saw.'}
    assert _counted([op]) == (1, 0)


def test_a_change_to_the_text_counts_as_one():
    op = {'kind': 'edit_text', 'sentence_id': 'd1-s1', 'begin': 0, 'end': 3, 'old': 'gam', 'new': 'Gam'}
    assert _counted([op])[1] == 1


def test_the_report_sums_them_per_document_and_in_its_totals(monkeypatch):
    """A gloss job's piece changes the person's gam 'fish' to 'net' in
    place and glosses the blank sa: one change to what people wrote."""
    client = JobClient({'d1': document('d1', 'Story', SPEC)})
    job = start(client, id=J)

    def answer(asked, n, kwargs):
        if n > 1 or 'Your piece:' not in asked:
            return reply('Done.')
        return reply(calls=[call(1, 'set_field', {'document': 'Story', 'refs': ['s1.w1.m1'], 'field': 'Morph Gloss',
                                                  'value': 'net'}),
                            call(2, 'set_analysis', {'document': 'Story', 'ref': 's2.w1', 'morphemes': [
                                {'form': 'sa', 'fields': {'Morph Gloss': 'see'}}]})])
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    report = finished['report']
    (doc,) = report['documents']
    assert doc['counts'].get('peoples_values_changed') == 1 == report['totals']['peoples_values_changed'], \
        doc['counts']
    assert report['totals']['changes'] >= 2
    assert report['totals']['text_changes'] == 0


def _linked_write(who):
    """s1.w1 "gam" with a word link of ``who``'s (wl1) and its morpheme with a person's link (l-d1-s1w1m1)."""
    from job_fixtures import stamp
    spec = [{'words': [('gam', [('gam', 'fish', 'vi-gam')], 'human'), 'ka']}]
    raw = document('d1', 'Story', spec)
    word_layer = raw['text_layers'][0]['token_layers'][1]
    word_layer['vocabs'][0]['vocab_links'].append({'id': 'wl1', 'vocab_item': {'id': 'vi-x', 'form': 'gam'},
                                                   'tokens': ['d1-s1w1'], 'metadata': stamp(who)})
    client = JobClient({'d1': raw})
    project = load_project(client, 'p1')
    doc = parse_document(client.documents.get('d1', include_body=True), project)
    return igt_job.Write('d1', '', Stretch(doc, project, doc.sentences, J), [], [], Counter(), doc)


def test_a_word_link_people_made_replaced_or_removed_counts_and_a_machines_does_not():
    """REV-DF-S-1: a word's link is found by its own id (the op's
    existing_link_id or link_id): a word has no morpheme to find it by."""
    replace = {'kind': 'link', 'token_id': 'd1-s1w1', 'item_id': 'vi-y', 'existing_link_id': 'wl1'}
    remove = {'kind': 'unlink', 'token_id': 'd1-s1w1', 'link_id': 'wl1'}
    first = {'kind': 'link', 'token_id': 'd1-s1w2', 'item_id': 'vi-y', 'existing_link_id': None}
    for op, n in ((replace, 1), (remove, 1), (first, 0)):
        assert _linked_write('human').of_people_and_text([op])['peoples_values_changed'] == n, op
        assert _linked_write('svc').of_people_and_text([op])['peoples_values_changed'] == 0, op


def test_the_link_op_of_a_planned_analysis_replacing_peoples_link_counts():
    """REV-DF-S-1: the link op of an analysis not written in place names no
    token, the word it is for and the link it replaces."""
    op = {'kind': 'link', 'token_id': None, 'analysis_word_id': 'd1-s1w1', 'morpheme_index': 0, 'item_id': 'vi-y',
          'existing_link_id': 'l-d1-s1w1m1'}
    assert _linked_write('human').of_people_and_text([op])['peoples_values_changed'] == 1
