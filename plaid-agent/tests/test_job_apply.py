"""THE apply rule (the owner's ruling 13 of 2026-11-13, igt/jobapply.py): what
a job applies by itself, decided per staged op by what it would change in the
document as it is under the lock, never by the tool that staged it.

A job stages through the assistant's own tools, so every op kind of the plan
layer can reach the rule. Each kind is named here against the rule; a kind
the rule does not name is never applied. The property test at the end runs
random plans over random documents and holds that nothing a person wrote,
confirmed or cleared differs after the job's write."""

import random
import re

import pytest

from job_fixtures import JobClient, Model, call, document, job_project, reply, runner, start, use

from plaid_agent.igt import jobapply, toolkit
from plaid_agent.igt.job import JobWorkspace, Stretch, word_tag, writing_form, writing_text
from plaid_agent.igt.plan import KIND, execute_plan
from plaid_agent.igt.project import load_project, parse_document

J = 'J1'


def mine(form, gloss='G'):
    return (form, [(form, gloss)], J)


def _story():
    return [
        {'words': ['blank', ('done', [('do', 'DO'), ('ne', 'NE')], 'human'), ('mach', [('mach', 'M')], 'machine'),
                   mine('own')], 'translation': ('A person wrote this.', 'human')},
        {'words': [{'form': 'valued', 'gloss': ('w', 'machine')}, 'free'], 'translation': ('Draft.', 'machine')},
        {'words': ['empty']},
        {'words': [mine('was')], 'translation': ('Mine.', J)},
    ]


class _Setup:
    """A piece's workspace over the story, and the runner that applies."""

    def __init__(self, sentences=None, known=(), mwe=None):
        self.client = JobClient({'d1': document('d1', 'Story', sentences or _story())})
        if mwe:
            # A person's multi-word expression over the two word ids ``mwe``.
            from fixtures import WORD_LAYER
            layer = next(tl for tl in self.client._holder('d1')['documents']['d1']['text_layers'][0]['token_layers']
                         if tl['id'] == WORD_LAYER)
            layer['vocabs'][0]['vocab_links'].append({'id': 'mwe1', 'vocab_item': {'id': 'e-mwe', 'form': 'x y'},
                                                      'tokens': list(mwe), 'metadata': {}})
        self.job = start(self.client, id=J)
        self.runner = runner(self.job)
        self.project = load_project(self.client, 'p1')
        self.ws = JobWorkspace(self.client, self.project)
        self.doc = self.ws.doc('d1')
        self.st = Stretch(self.doc, self.project, self.doc.sentences, J)
        self.ws.stretch = self.st
        # The job vouches for its own words as their sentences' records say.
        self.runner.recorded_words = lambda docs: {w.id: __import__('plaid_agent.igt.job', fromlist=['x']).word_key(w)
                                                   for d in docs.values() for s in d.sentences for w in s.words}
        self.runner.commented = lambda client, project, document_id: set()
        if known:
            self.runner.writing['d1'] = {'earlier': {'translation': None, 'words': set(known), 'others': set()}}
            self.runner.unsent['d1'] = set()

    def stage(self, name, args):
        out = toolkit.job_piece_call(self.ws, name, {'document': 'Story', **args})
        assert not str(out).startswith('Error'), out
        return out

    def decide(self):
        prints = {s.id: self.ws.sentence_print(self.doc, s) for s in self.doc.sentences}
        kept, counts, changed, proposed = self.runner.recheck(self.ws, self.project, self.doc, self.st, prints,
                                                              list(self.ws.ops))
        return kept, proposed


# --- every kind is named ----------------------------------------------------------------

def test_every_kind_of_the_plan_is_named_by_the_rule():
    """A kind added to the plan layer fails here until the rule names it
    (applied by a test of its own, or proposed)."""
    assert jobapply.unnamed_kinds() == set(), jobapply.unnamed_kinds()
    assert jobapply.APPLIED_KINDS.isdisjoint(jobapply.PROPOSED_KINDS)
    assert set(KIND) == jobapply.known_kinds()


def test_a_kind_the_rule_does_not_know_is_not_applied():
    s = _Setup()
    rule = jobapply.Rule(s.doc, s.project, frozenset(), own=lambda w: True, target=lambda w: True,
                         tag=word_tag, job_piece=lambda md: True)
    assert rule.alone({'kind': 'a_kind_added_tomorrow', 'token_id': s.doc.sentences[0].id}) == jobapply.PROPOSE


@pytest.mark.parametrize('kind', sorted(jobapply.PROPOSED_KINDS))
def test_each_proposed_kind_is_never_applied_whatever_it_touches(kind):
    s = _Setup()
    rule = jobapply.Rule(s.doc, s.project, frozenset(), own=lambda w: True, target=lambda w: True,
                         tag=word_tag, job_piece=lambda md: True)
    blank = s.doc.sentences[0].words[0]
    assert rule.alone({'kind': kind, 'word_id': blank.id, 'token_id': blank.id}) == jobapply.PROPOSE


# --- the applied kinds, case by case ----------------------------------------------------

@pytest.mark.parametrize('name,args,applied', [
    # A value that fills something empty.
    ('set_field', {'refs': ['s3'], 'field': 'Translation', 'value': 'T.'}, True),
    ('set_field', {'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'g'}, True),
    # A value a person wrote, another machine's, the job's own.
    ('set_field', {'refs': ['s1'], 'field': 'Translation', 'value': 'T.'}, False),
    ('set_field', {'refs': ['s2'], 'field': 'Translation', 'value': 'T.'}, False),
    ('set_field', {'refs': ['s4'], 'field': 'Translation', 'value': 'Mine again.'}, True),
    ('set_field', {'refs': ['s2.w1'], 'field': 'Gloss', 'value': 'g'}, False),
    # A word: blank, a person's, another machine's, the job's own vouched work.
    ('set_analysis', {'ref': 's1.w1', 'morphemes': [{'form': 'blank'}]}, True),
    ('set_analysis', {'ref': 's1.w2', 'morphemes': [{'form': 'done'}]}, False),
    ('set_analysis', {'ref': 's1.w3', 'morphemes': [{'form': 'mach'}]}, False),
    ('set_analysis', {'ref': 's1.w4', 'morphemes': [{'form': 'ow'}, {'form': 'n'}]}, True),
    ('set_analysis', {'ref': 's2.w1', 'morphemes': [{'form': 'valued'}]}, False),
    # A morpheme's value: of a person's analysis, of the job's own.
    ('set_field', {'refs': ['s1.w2.m1'], 'field': 'Morph Gloss', 'value': 'X'}, False),
    ('set_field', {'refs': ['s1.w4.m1'], 'field': 'Morph Gloss', 'value': 'X'}, True),
    # A link from a morpheme of a person's analysis, of the job's own.
    ('link_entry', {'refs': ['s1.w2.m1'], 'entry_id': 'vi-gam'}, False),
    ('link_entry', {'refs': ['s1.w4.m1'], 'entry_id': 'vi-gam'}, True),
    # Deletions, renames, shapes, settings: never.
    ('delete_word', {'refs': ['s1.w1']}, False),
    ('split_word', {'ref': 's1.w1', 'at': 2}, False),
    ('discard_analysis', {'refs': ['s1.w4']}, False),
])
def test_each_change_by_what_it_changes(name, args, applied):
    s = _Setup()
    s.stage(name, args)
    kept, proposed = s.decide()
    assert bool(kept) == applied and bool(proposed) != applied, (kept, proposed)


@pytest.mark.parametrize('name,args', [
    ('set_analysis', {'ref': 's1.w1', 'morphemes': [{'form': 'blank'}]}),
    ('set_field', {'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'g'}),
    ('link_entry', {'refs': ['s1.w1.m1'], 'entry_id': 'vi-gam'}),
])
@pytest.mark.parametrize('why', ['comment', 'mwe'])
def test_a_blank_word_with_a_comment_or_in_a_persons_expression_is_not_blank(name, args, why):
    """The lead's ruling on REV-JG's "blank": a blank word that carries a
    comment, or sits in a person's multi-word expression, is people's
    ground, as harmonize already holds it: what fills it is proposed."""
    s = _Setup(mwe=('d1-s1w1', 'd1-s3w1') if why == 'mwe' else None)
    if why == 'comment':
        s.runner.commented = lambda client, project, document_id: {'d1-s1w1'}
    s.stage(name, args)
    kept, proposed = s.decide()
    assert not kept and proposed, (kept, proposed)


def test_a_blank_word_with_neither_is_filled():
    """The guard: the same blank word, nothing on it, is filled."""
    s = _Setup()
    s.stage('set_analysis', {'ref': 's1.w1', 'morphemes': [{'form': 'blank'}]})
    kept, proposed = s.decide()
    assert kept and not proposed


def test_an_empty_value_is_a_deletion_and_is_proposed():
    s = _Setup()
    s.stage('set_field', {'refs': ['s4'], 'field': 'Translation', 'value': ''})
    kept, proposed = s.decide()
    assert not kept and proposed[0]['from'] == 'Mine.' and proposed[0]['to'] in ('', None)


def test_empty_is_not_enough_where_the_job_wrote_before():
    """The lead's note: a sentence holding a word of a sentence the job wrote
    in (its writing rows) is never filled again, however empty it reads: a
    person may have cleared it."""
    s = _Setup(known={word_tag('d1-s3w1')})
    s.stage('set_field', {'refs': ['s3'], 'field': 'Translation', 'value': 'T.'})
    s.stage('set_analysis', {'ref': 's3.w1', 'morphemes': [{'form': 'empty'}]})
    kept, proposed = s.decide()
    assert kept == [] and [c['kind'] for c in proposed] == ['set_span', 'set_analysis']


def test_a_link_to_a_new_entry_and_the_entry_go_with_the_analysis_they_hang_on():
    s = _Setup()
    s.stage('set_analysis', {'ref': 's1.w1', 'morphemes': [{'form': 'blank', 'fields': {'Morph Gloss': 'B'}}]})
    made = toolkit.job_piece_call(s.ws, 'create_entry', {'form': 'blank', 'fields': {'gloss': 'B'}})
    key = made.split('entry_id: ')[1].split()[0]
    s.stage('link_entry', {'refs': ['s1.w1.m1'], 'entry_id': key})
    kept, proposed = s.decide()
    assert sorted(o['kind'] for o in kept) == ['create_entry', 'link', 'set_analysis'] and not proposed


def test_a_link_on_a_morpheme_of_a_proposed_analysis_is_proposed_too():
    """A plan is split, and an op that depends on one not applied is not
    applied either (the plan layer's own links between ops)."""
    s = _Setup()
    s.stage('set_analysis', {'ref': 's1.w2', 'morphemes': [{'form': 'done', 'fields': {'Morph Gloss': 'D'}}]})
    s.stage('link_entry', {'refs': ['s1.w2.m1'], 'entry_id': 'vi-gam'})
    kept, proposed = s.decide()
    assert kept == [] and sorted(c['kind'] for c in proposed) == ['link', 'set_analysis']


def test_a_change_in_a_sentence_a_proposed_reshape_recuts_is_proposed():
    s = _Setup([{'words': ['a', 'b']}])
    s.stage('set_field', {'refs': ['s1'], 'field': 'Translation', 'value': 'T.'})
    s.stage('split_sentence', {'ref': 's1', 'before_word': 2})
    kept, proposed = s.decide()
    assert kept == [] and sorted(c['kind'] for c in proposed) == ['set_span', 'split_sentence']


def test_an_entry_in_a_lexicon_with_no_status_field_is_proposed():
    p = job_project()
    del p['vocabs'][0]['config']['igt']['fields']['status']
    s = _Setup()
    s.project.vocabs[0]['fields'] = [f for f in s.project.vocabs[0].get('fields') or [] if f.get('role') != 'status']
    s.project.vocabs[0].setdefault('config', {})
    rule = jobapply.Rule(s.doc, s.project, frozenset(), own=lambda w: True, target=lambda w: True,
                         tag=word_tag, job_piece=lambda md: True)
    from plaid_agent.igt.project import IgtProject
    if IgtProject.lexicon_field(s.project.vocabs[0], 'status'):
        pytest.skip('the fixture keeps its Status field elsewhere')
    assert rule.alone({'kind': 'create_entry', 'vocab_id': s.project.vocabs[0]['id'], 'form': 'x',
                       'metadata': {}}) == jobapply.PROPOSE


def test_a_proposed_change_says_what_where_and_from_what_to_what():
    s = _Setup()
    s.stage('set_analysis', {'ref': 's1.w2', 'morphemes': [{'form': 'done', 'fields': {'Morph Gloss': 'D'}}]})
    s.stage('set_field', {'refs': ['s1'], 'field': 'Translation', 'value': 'Better.'})
    _kept, proposed = s.decide()
    by_kind = {c['kind']: c for c in proposed}
    assert by_kind['set_analysis'] | {} == {**by_kind['set_analysis'], 'document': 'Story', 'ref': 's1.w2',
                                            'from': 'do-ne ‘DO-NE’', 'to': 'done ‘D’'}
    assert (by_kind['set_span']['ref'], by_kind['set_span']['field'], by_kind['set_span']['from'],
            by_kind['set_span']['to']) == ('s1', 'Translation', 'A person wrote this.', 'Better.')
    assert all(c['label'] for c in proposed)


def test_a_piece_writes_what_the_rule_applies_and_records_the_rest(monkeypatch):
    """End to end on a stretch: the blank word is written, the person's word
    is not, and the report's proposed changes hold it with the piece's note."""
    from plaid_agent.core.job import run_job
    client = JobClient({'d1': document('d1', 'Story', _story()[:1])})
    job = start(client, 'Gloss every word again.', id=J)

    def answer(asked, n, kwargs):
        if n == 1:
            return reply(calls=[call(1, 'set_analysis', {'document': 'Story', 'analyses': [
                {'ref': 's1.w1', 'morphemes': [{'form': 'blank', 'fields': {'Morph Gloss': 'B'}}]},
                {'ref': 's1.w2', 'morphemes': [{'form': 'done', 'fields': {'Morph Gloss': 'D'}}]}]})])
        return reply('Glossed s1. Proposed a new analysis of done.')
    use(monkeypatch, Model(answer))
    written = []
    real = __import__('plaid_agent.igt.job', fromlist=['x']).execute_plan

    def execute(c, ops, **kw):
        written.extend(o.get('word_id') for o in ops if o.get('kind') == 'set_analysis')
        return real(c, ops, **kw)
    monkeypatch.setattr('plaid_agent.igt.job.execute_plan', execute)
    finished = run_job(job, runner(job))
    assert written == ['d1-s1w1']
    (change,) = finished['report']['proposed']
    assert (change['ref'], change['from'], change['to']) == ('s1.w2', 'do-ne ‘DO-NE’', 'done ‘D’')
    assert change['note'] == 'Glossed s1. Proposed a new analysis of done.'
    assert finished['report']['totals']['proposed'] == 1
    assert finished['report']['notes'][0]['note'] == 'Glossed s1. Proposed a new analysis of done.'


def test_proposed_changes_are_capped_and_the_report_counts_the_rest(monkeypatch):
    from plaid_agent.core import limits
    from plaid_agent.igt import job as igt_job
    monkeypatch.setattr(igt_job, 'JOB_CHANGES_MAX', 2)
    s = _Setup()
    changes = [{'kind': 'set_span', 'document_id': 'd1', 'document': 'Story', 'ref': f's{i}', 'field': 'T',
                'from': 'a', 'to': f'b{i}', 'label': 'x'} for i in range(5)]
    s.runner.record_changes(changes, 'note')
    s.runner.record_changes(changes, 'note')  # the same again: kept once, counted once
    parts = s.runner.report_parts(s.job)
    assert len(parts['proposed']) == 2 and parts['proposed_dropped'] == 6 and parts['proposed_more'] == 6
    assert limits.JOB_CHANGES_MAX == limits.JOB_REPORT_LIST_MAX


# --- the property: nothing a person wrote, confirmed or cleared differs ------------------

_WHO = ['human', 'machine', J, f'confirmed:{J}', 'blank']
_TOOLS = ['set_field_t', 'set_field_w', 'set_field_m', 'set_analysis', 'link', 'delete_word', 'merge_words',
          'split_word', 'discard', 'confirm', 'comment', 'morph_type']


def _random_story(rng):
    sentences = []
    for si in range(rng.randint(1, 3)):
        words = []
        for wi in range(rng.randint(1, 3)):
            form = f'w{si}{wi}' + rng.choice(['a', 'ka', 'ta'])
            who = rng.choice(_WHO)
            if who == 'blank':
                words.append(form)
            elif rng.random() < 0.3:
                words.append({'form': form, 'gloss': ('g', who), 'morphs': [(form, 'G')], 'who': who})
            else:
                words.append((form, [(form[:2], 'A'), (form[2:], 'B')] if rng.random() < 0.5 else [(form, 'A')],
                              who))
        t = rng.choice(_WHO)
        sentences.append({'words': words, **({} if t == 'blank' else {'translation': ('T.', t)})})
    return sentences


def _random_calls(rng, doc):
    calls = []
    for _ in range(rng.randint(1, 6)):
        s = rng.choice(doc.sentences)
        w = rng.choice(s.words)
        ref = f's{s.index}.w{w.index}'
        tool = rng.choice(_TOOLS)
        if tool == 'set_field_t':
            calls.append(('set_field', {'refs': [f's{s.index}'], 'field': 'Translation', 'value': rng.choice(['N.', ''])}))
        elif tool == 'set_field_w':
            calls.append(('set_field', {'refs': [ref], 'field': 'Gloss', 'value': rng.choice(['n', ''])}))
        elif tool == 'set_field_m':
            calls.append(('set_field', {'refs': [ref + '.m1'], 'field': 'Morph Gloss', 'value': 'N'}))
        elif tool == 'set_analysis':
            calls.append(('set_analysis', {'ref': ref, 'morphemes': [{'form': w.surface, 'fields': {'Morph Gloss': 'N'}}]}))
        elif tool == 'link':
            calls.append(('link_entry', {'refs': [ref + '.m1'], 'entry_id': 'vi-gam'}))
        elif tool == 'delete_word':
            calls.append(('delete_word', {'refs': [ref]}))
        elif tool == 'merge_words' and len(s.words) > 1:
            calls.append(('merge_words', {'refs': [f's{s.index}.w1', f's{s.index}.w2']}))
        elif tool == 'split_word':
            calls.append(('split_word', {'ref': ref, 'at': 1}))
        elif tool == 'discard':
            calls.append(('discard_analysis', {'refs': [ref]}))
        elif tool == 'confirm':
            calls.append(('confirm', {'refs': [ref]}))
        elif tool == 'comment':
            calls.append(('add_comment', {'ref': ref, 'body': 'Look.'}))
        else:
            calls.append(('set_morpheme', {'ref': ref + '.m1', 'type': 'stem'}))
    return calls


def _person_ids(doc):
    """Every id of a piece a person wrote or confirmed: what a job may never
    change or delete."""
    from plaid_client.provenance import prov_state
    out = set()
    for s in doc.sentences:
        for sp in s.fields.values():
            if prov_state(sp.metadata) != 'machine' or (sp.metadata or {}).get('provConfirmed'):
                out.add(sp.id)
        for w in s.words:
            pieces = [(sp.id, sp.metadata) for sp in w.fields.values()]
            for m in w.morphemes:
                if m.virtual:
                    continue
                pieces.append((m.id, m.metadata))
                pieces += [(sp.id, sp.metadata) for sp in m.fields.values()]
                if m.link is not None:
                    pieces.append((m.link.id, m.link.metadata))
            for pid, md in pieces:
                if prov_state(md) != 'machine' or (md or {}).get('provConfirmed'):
                    out.add(pid)
    return out


@pytest.mark.parametrize('seed', range(60))
def test_nothing_a_person_wrote_confirmed_or_cleared_differs_on_any_plan(seed):
    rng = random.Random(seed)
    sentences = _random_story(rng)
    # Some sentences the job wrote in before: their words are known.
    s = _Setup(sentences)
    known = {word_tag(w.id) for sn in s.doc.sentences if rng.random() < 0.3 for w in sn.words}
    if known:
        s.runner.writing['d1'] = {'earlier': {'translation': None, 'words': set(known), 'others': set()}}
        s.runner.unsent['d1'] = set()
    for name, args in _random_calls(rng, s.doc):
        toolkit.job_piece_call(s.ws, name, {'document': 'Story', **args})
    kept, proposed = s.decide()
    people = _person_ids(s.doc)
    from plaid_agent.igt.job import job_owned, word_target
    for op in kept:
        assert op['kind'] in jobapply.APPLIED_KINDS, op
        hit = jobapply._found(s.doc, jobapply.token_of(op))
        if op['kind'] == 'create_entry' or hit is None:
            continue
        sn, w, m = hit
        wrote_in = any(word_tag(x.id) in known for x in sn.words)
        if w is not None and op['kind'] != 'set_span':
            assert job_owned(w, J) or (word_target(w) and not wrote_in), (seed, op)
        if op['kind'] == 'set_span':
            assert op.get('value'), (seed, op)
            assert op.get('span_id') is None or op['span_id'] not in people, (seed, op)
            if op.get('span_id') is None and op['token_id'] == sn.id:
                assert not wrote_in, (seed, op)
    # Written through the plan's own executor: no call changes or deletes a
    # piece a person wrote or confirmed.
    if kept:
        s.client.calls.clear()
        execute_plan(s.client, kept, source='service:igt:job:m', label='x', project=s.project, stamp_mode='machine',
                     detail={'model': 'm', 'version': 'v', 'job': J}, seed=str(__import__('plaid_client').uuid7()))
        for kind, payload in s.client.calls:
            if kind.endswith(('.create', '.read', '.get')) or kind in ('operation', 'lock', 'unlock', 'read'):
                continue
            named = set(re.findall(r'[\w:.-]+', str(payload)))
            assert not (people & named), (seed, kind, payload)
