"""THE apply rule (the owner's rulings 17 to 20 of 2026-11-13, igt/jobapply.py):
a job applies whatever it plans inside its documents and in the project's
lexicons, deletions and changes to people's work included. It never deletes a
document, and project setup (guidelines, tagsets, a document's metadata,
creating or renaming a document) stays a proposed change in its report.

A job stages through the assistant's own tools, so every op kind of the plan
layer can reach the rule. Each kind is named here against the rule; a kind
the rule does not name is never applied. The property test at the end runs
random plans over random documents and holds that no applied op is project
setup, nothing deletes a document, and every value written is the job's
unverified machine proposal."""

import random
import re

import pytest

from job_fixtures import JobClient, Model, call, document, job_project, reply, runner, start, use

from plaid_agent.igt import jobapply, toolkit
from plaid_agent.igt.job import JobWorkspace, Stretch
from plaid_agent.igt.plan import KIND, execute_plan
from plaid_agent.igt.project import load_project

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

    def __init__(self, sentences=None, maintains=True):
        self.client = JobClient({'d1': document('d1', 'Story', sentences or _story()),
                                 'd2': document('d2', 'Other', [{'words': ['other']}])})
        self.job = start(self.client, id=J)
        self.runner = runner(self.job)
        self.runner._maintains = maintains
        self.project = load_project(self.client, 'p1')
        self.ws = JobWorkspace(self.client, self.project)
        self.doc = self.ws.doc('d1')
        self.st = Stretch(self.doc, self.project, self.doc.sentences, J)
        self.ws.stretch = self.st

    def stage(self, name, args, document='Story'):
        out = toolkit.job_piece_call(self.ws, name, {**({'document': document} if document else {}), **args})
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
    (applied, or proposed)."""
    assert jobapply.unnamed_kinds() == set(), jobapply.unnamed_kinds()
    assert jobapply.APPLIED_KINDS.isdisjoint(jobapply.PROPOSED_KINDS)
    assert jobapply.SETUP_KINDS <= jobapply.PROPOSED_KINDS
    assert set(KIND) == jobapply.known_kinds()


def test_project_setup_is_every_settings_kind_and_the_documents_own():
    """Ruling 19: guidelines, tagsets, a document's metadata, creating and
    renaming a document. The registry's own settings kinds are among them."""
    from plaid_agent.igt.plan import SETTINGS_KINDS
    assert set(SETTINGS_KINDS) <= jobapply.SETUP_KINDS
    assert {'add_guideline', 'revise_guideline', 'rewrite_guideline', 'create_document', 'rename_document',
            'set_doc_metadata'} <= jobapply.SETUP_KINDS


def test_a_kind_the_rule_does_not_know_is_not_applied():
    s = _Setup()
    rule = jobapply.Rule(s.doc, s.project)
    assert rule.alone({'kind': 'a_kind_added_tomorrow', 'token_id': s.doc.sentences[0].id}) == jobapply.PROPOSE
    assert rule.alone({'kind': 'delete_document', 'document_id': 'd1'}) == jobapply.PROPOSE


@pytest.mark.parametrize('kind', sorted(jobapply.PROPOSED_KINDS))
def test_each_proposed_kind_is_never_applied_whatever_it_touches(kind):
    s = _Setup()
    rule = jobapply.Rule(s.doc, s.project)
    blank = s.doc.sentences[0].words[0]
    assert rule.alone({'kind': kind, 'word_id': blank.id, 'token_id': blank.id, 'document_id': 'd1'}) \
        == jobapply.PROPOSE


@pytest.mark.parametrize('kind', sorted(jobapply.APPLIED_KINDS - {'create_entry'}))
def test_each_applied_kind_is_applied_in_the_document_under_the_lock(kind):
    s = _Setup()
    rule = jobapply.Rule(s.doc, s.project)
    w = s.doc.sentences[0].words[1]
    assert rule.alone({'kind': kind, 'word_id': w.id}) == jobapply.APPLY


# --- what a piece stages, applied whoever wrote what it changes -------------------------

@pytest.mark.parametrize('name,args,kind', [
    # Values: empty, a person's, another machine's, the job's own.
    ('set_field', {'refs': ['s3'], 'field': 'Translation', 'value': 'T.'}, 'set_span'),
    ('set_field', {'refs': ['s1'], 'field': 'Translation', 'value': 'T.'}, 'set_span'),
    ('set_field', {'refs': ['s2'], 'field': 'Translation', 'value': 'T.'}, 'set_span'),
    ('set_field', {'refs': ['s4'], 'field': 'Translation', 'value': 'Mine again.'}, 'set_span'),
    ('set_field', {'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'g'}, 'set_span'),
    ('set_field', {'refs': ['s2.w1'], 'field': 'Gloss', 'value': 'g'}, 'set_span'),
    # A value cleared is a deletion, applied.
    ('set_field', {'refs': ['s1'], 'field': 'Translation', 'value': ''}, 'set_span'),
    # A word: blank, a person's, another machine's, the job's own.
    ('set_analysis', {'ref': 's1.w1', 'morphemes': [{'form': 'blank'}]}, 'set_analysis'),
    ('set_analysis', {'ref': 's1.w2', 'morphemes': [{'form': 'done'}]}, 'set_analysis'),
    ('set_analysis', {'ref': 's1.w3', 'morphemes': [{'form': 'mach'}]}, 'set_analysis'),
    ('set_analysis', {'ref': 's1.w4', 'morphemes': [{'form': 'ow'}, {'form': 'n'}]}, 'set_analysis'),
    # A morpheme's value and link on a person's analysis.
    ('set_field', {'refs': ['s1.w2.m1'], 'field': 'Morph Gloss', 'value': 'X'}, 'set_span'),
    ('link_entry', {'refs': ['s1.w2.m1'], 'entry_id': 'vi-gam'}, 'link'),
    ('set_morpheme', {'ref': 's1.w2.m1', 'type': 'stem'}, 'set_morph_type'),
    # Deletions, shapes, text, comments.
    ('delete_word', {'refs': ['s1.w2']}, 'delete_word'),
    ('split_word', {'ref': 's1.w1', 'at': 2}, 'split_word'),
    ('merge_words', {'refs': ['s1.w1', 's1.w2']}, 'merge_words'),
    ('discard_analysis', {'refs': ['s1.w3']}, 'discard_analysis'),
    ('split_sentence', {'ref': 's1', 'before_word': 2}, 'split_sentence'),
    ('merge_sentences', {'ref': 's2'}, 'merge_sentences'),
    ('delete_sentence', {'refs': ['s2']}, 'delete_sentence'),
    ('respell', {'ref': 's1.w1', 'new_text': 'blanc'}, 'respell'),
    ('retype_sentence', {'ref': 's3', 'text': 'empty again'}, 'edit_text'),
    ('add_comment', {'ref': 's1.w2', 'body': 'Check this.'}, 'add_comment'),
])
def test_a_change_in_the_document_is_applied_whoever_wrote_what_it_changes(name, args, kind):
    s = _Setup()
    s.stage(name, args)
    kept, proposed = s.decide()
    assert kind in [o['kind'] for o in kept] and not proposed, (kept, proposed)


def test_what_kept_a_job_off_a_blank_word_before_keeps_it_off_no_longer():
    """The withdrawn rulings: a person's multi-word expression or an empty
    value on a word kept a job off it. The rule applies its analysis there
    now, and reads no comment (the live test holds comments). A sentence the
    job wrote in before is left out of a later write before the rule, the
    job working each sentence once (test_job_gate)."""
    from fixtures import WORD_LAYER
    sentences = _story()
    sentences[0]['words'][0] = {'form': 'blank', 'gloss': ('', 'human')}
    s = _Setup(sentences)
    layer = next(tl for tl in s.client._holder('d1')['documents']['d1']['text_layers'][0]['token_layers']
                 if tl['id'] == WORD_LAYER)
    layer['vocabs'][0]['vocab_links'].append({'id': 'mwe1', 'vocab_item': {'id': 'e-mwe', 'form': 'x y'},
                                              'tokens': ['d1-s1w1', 'd1-s3w1'], 'metadata': {}})
    s.doc = s.ws.doc('d1')
    s.stage('set_analysis', {'ref': 's1.w1', 'morphemes': [{'form': 'blank'}]})
    s.stage('set_field', {'refs': ['s3'], 'field': 'Translation', 'value': 'T.'})
    kept, proposed = s.decide()
    assert sorted(o['kind'] for o in kept) == ['set_analysis', 'set_span'] and not proposed


def test_a_link_to_a_new_entry_and_the_entry_go_with_the_analysis_they_hang_on():
    s = _Setup()
    s.stage('set_analysis', {'ref': 's1.w1', 'morphemes': [{'form': 'blank', 'fields': {'Morph Gloss': 'B'}}]})
    made = toolkit.job_piece_call(s.ws, 'create_entry', {'form': 'blank', 'fields': {'gloss': 'B'}})
    key = made.split('entry_id: ')[1].split()[0]
    s.stage('link_entry', {'refs': ['s1.w1.m1'], 'entry_id': key})
    kept, proposed = s.decide()
    assert sorted(o['kind'] for o in kept) == ['create_entry', 'link', 'set_analysis'] and not proposed


def test_an_entry_nothing_links_is_created_when_the_job_stages_it():
    """A job told to add entries to the lexicon makes them, linked or not."""
    s = _Setup()
    toolkit.job_piece_call(s.ws, 'create_entry', {'form': 'novel', 'fields': {'gloss': 'N'}})
    kept, proposed = s.decide()
    assert [o['kind'] for o in kept] == ['create_entry'] and not proposed


@pytest.mark.parametrize('name,args', [
    ('delete_entry', {'entry_id': 'vi-gam'}),
    ('merge_entries', {'keep_id': 'vi-gam', 'remove_id': 'vi-gam2'}),
    ('rename_entry', {'entry_id': 'vi-gam', 'new_form': 'gaam'}),
    ('set_entry_field', {'entry_id': 'vi-gam', 'field': 'gloss', 'value': 'fishes'}),
])
def test_the_lexicon_is_changed_entries_deleted_and_merged_included(name, args):
    s = _Setup()
    s.stage(name, args, document=None)
    kept, proposed = s.decide()
    assert kept and not proposed, (kept, proposed)


@pytest.mark.parametrize('name,args,applied', [
    ('delete_entry', {'entry_id': 'vi-gam'}, False),
    ('merge_entries', {'keep_id': 'vi-gam', 'remove_id': 'vi-gam2'}, False),
    ('rename_entry', {'entry_id': 'vi-gam', 'new_form': 'gaam'}, False),
    ('set_entry_field', {'entry_id': 'vi-gam', 'field': 'gloss', 'value': 'fishes'}, True),
])
def test_a_change_core_refuses_to_the_starter_is_proposed(name, args, applied):
    """A job's token is its starter's: when they are no maintainer of the
    project, core refuses them a rename, merge or deletion of an entry, so
    the job lists it rather than fail on it. A writer still edits entries."""
    s = _Setup(maintains=False)
    s.stage(name, args, document=None)
    kept, proposed = s.decide()
    assert bool(kept) == applied and bool(proposed) != applied, (kept, proposed)


def test_whether_the_starter_maintains_is_their_role_or_administration():
    s = _Setup()
    s.runner._maintains = None
    s.project.roles = {'maintainers': [s.job.starter]}
    assert s.runner.starter_maintains(s.ws, s.project)
    s.runner._maintains = None
    s.project.roles = {'writers': [s.job.starter]}
    assert not s.runner.starter_maintains(s.ws, s.project)


def test_a_change_in_another_document_is_proposed():
    """Not under the lock of the document the piece writes: listed."""
    s = _Setup()
    s.ws.doc('d2')
    s.stage('set_field', {'refs': ['s1'], 'field': 'Translation', 'value': 'T.'}, document='Other')
    kept, proposed = s.decide()
    assert not kept and [c['document_id'] for c in proposed] == ['d2']


@pytest.mark.parametrize('name,args,kind', [
    ('guidelines', {'action': 'add', 'title': 'Copulas', 'body': 'Gloss я as COP.'}, 'add_guideline'),
    ('rename_document', {'new_name': 'Story one'}, 'rename_document'),
    ('create_document', {'name': 'New', 'text': 'a b'}, 'create_document'),
    ('confirm', {'refs': ['s1.w3']}, 'confirm'),
])
def test_project_setup_and_a_confirmation_are_listed_never_applied(name, args, kind):
    s = _Setup()
    if name == 'guidelines':
        toolkit.job_piece_call(s.ws, 'guidelines', {'action': 'help'})
    s.stage(name, args, document=None if name in ('guidelines', 'create_document') else 'Story')
    kept, proposed = s.decide()
    assert not kept and [c['kind'] for c in proposed] == [kind], (kept, proposed)


def test_an_op_that_depends_on_one_not_applied_is_not_applied():
    """A link to an entry the job cannot make (a lexicon with no Status
    field) is listed with it."""
    s = _Setup()
    v = s.project.vocabs[0]
    rule = jobapply.Rule(s.doc, s.project)
    ops = [{'kind': 'create_entry', 'key': 'k1', 'vocab_id': v['id'], 'form': 'x'},
           {'kind': 'link', 'token_id': 'd1-s1w2m1', 'new_entry_key': 'k1'}]
    from plaid_agent.igt.project import IgtProject
    real = IgtProject.lexicon_field
    try:
        IgtProject.lexicon_field = staticmethod(lambda vocab, role: None)
        fates = jobapply.decide(ops, rule, lambda t: None, lambda op: set())
    finally:
        IgtProject.lexicon_field = staticmethod(real)
    assert fates == [jobapply.PROPOSE, jobapply.PROPOSE]


def test_a_proposed_change_says_what_where_and_from_what_to_what():
    s = _Setup()
    op = {'kind': 'set_analysis', 'word_id': 'd1-s1w2',
          'morphemes': [{'form': 'done', 'fields': [{'layer_id': s.project.gloss_field('Morpheme').layer_id,
                                                     'value': 'D'}]}], 'label': 'x'}
    c = s.runner.describe(op, s.doc, s.project)
    assert (c['document'], c['ref'], c['from'], c['to']) == ('Story', 's1.w2', 'do-ne ‘DO-NE’', 'done ‘D’')


def test_a_piece_writes_what_it_staged_and_lists_only_project_setup(monkeypatch):
    """End to end on a stretch: the blank word and the person's word are
    both written, and the guideline the piece staged is the report's one
    proposed change, with the piece's note."""
    from plaid_agent.core.job import run_job
    client = JobClient({'d1': document('d1', 'Story', _story()[:1])})
    job = start(client, 'Gloss every word again.', id=J)

    def answer(asked, n, kwargs):
        if n == 1:
            return reply(calls=[call(1, 'set_analysis', {'document': 'Story', 'analyses': [
                {'ref': 's1.w1', 'morphemes': [{'form': 'blank', 'fields': {'Morph Gloss': 'B'}}]},
                {'ref': 's1.w2', 'morphemes': [{'form': 'done', 'fields': {'Morph Gloss': 'D'}}]}]}),
                call(2, 'guidelines', {'action': 'help'})])
        if n == 2:
            return reply(calls=[call(3, 'guidelines', {'action': 'add', 'title': 'Done',
                                                        'body': 'Gloss done as D.'})])
        return reply('Glossed s1 again. Proposed a guideline on done.')
    use(monkeypatch, Model(answer))
    written = []
    real = __import__('plaid_agent.igt.job', fromlist=['x']).execute_plan

    def execute(c, ops, **kw):
        written.extend(o.get('word_id') for o in ops if o.get('kind') == 'set_analysis')
        return real(c, ops, **kw)
    monkeypatch.setattr('plaid_agent.igt.job.execute_plan', execute)
    finished = run_job(job, runner(job))
    assert written == ['d1-s1w1', 'd1-s1w2']
    (change,) = finished['report']['proposed']
    assert change['kind'] == 'add_guideline' and change['document_id'] is None
    assert change['note'] == 'Glossed s1 again. Proposed a guideline on done.'
    totals = finished['report']['totals']
    assert totals['proposed'] == 1 and totals['changes'] == 2 and totals['deletions'] == 0


def test_proposed_changes_are_capped_and_the_report_counts_the_rest(monkeypatch):
    from plaid_agent.core import limits
    from plaid_agent.igt import job as igt_job
    monkeypatch.setattr(igt_job, 'JOB_CHANGES_MAX', 2)
    s = _Setup()
    changes = [{'kind': 'add_guideline', 'document_id': None, 'document': None, 'ref': None, 'field': None,
                'from': None, 'to': f'b{i}', 'label': 'x'} for i in range(5)]
    s.runner.record_changes(changes, 'note')
    s.runner.record_changes(changes, 'note')  # the same again: kept once, counted once
    parts = s.runner.report_parts(s.job)
    assert len(parts['proposed']) == 2 and parts['proposed_dropped'] == 6 and parts['proposed_more'] == 6
    assert limits.JOB_CHANGES_MAX == limits.JOB_REPORT_LIST_MAX


# --- the property: no setup applied, no document deleted, every value the job's ------------

_WHO = ['human', 'machine', J, f'confirmed:{J}', 'blank']
_TOOLS = ['set_field_t', 'set_field_w', 'set_field_m', 'set_analysis', 'link', 'delete_word', 'merge_words',
          'split_word', 'discard', 'confirm', 'comment', 'morph_type', 'guideline', 'rename_document',
          'metadata', 'create_document', 'delete_entry', 'create_entry', 'delete_sentence']


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
        elif tool == 'guideline':
            calls.append(('guidelines', {'action': 'add', 'title': f'G{len(calls)}', 'body': 'Gloss it so.'}))
        elif tool == 'rename_document':
            calls.append(('rename_document', {'new_name': f'Story {len(calls)}'}))
        elif tool == 'metadata':
            calls.append(('set_document_metadata', {'field': 'Speaker', 'value': 'Ana'}))
        elif tool == 'create_document':
            calls.append(('create_document', {'name': f'New {len(calls)}', 'text': 'a b'}))
        elif tool == 'delete_entry':
            calls.append(('delete_entry', {'entry_id': 'vi-gam2'}))
        elif tool == 'delete_sentence':
            calls.append(('delete_sentence', {'refs': [f's{s.index}']}))
        elif tool == 'create_entry':
            calls.append(('create_entry', {'form': f'new{len(calls)}', 'fields': {'gloss': 'N'}}))
        else:
            calls.append(('set_morpheme', {'ref': ref + '.m1', 'type': 'stem'}))
    return calls


#: Client calls that write project setup or remove a document: never made by
#: a job's write.
_FORBIDDEN = re.compile(r'^(documents\.(delete|create|patch|rename|update_name|patch_metadata)|'
                        r'projects\.|vocab_layers\.|span_layers\.|token_layers\.|text_layers\.)')


@pytest.mark.parametrize('seed', range(60))
def test_a_job_never_applies_project_setup_and_never_deletes_a_document_on_any_plan(seed):
    rng = random.Random(seed)
    s = _Setup(_random_story(rng))
    toolkit.job_piece_call(s.ws, 'guidelines', {'action': 'help'})
    for name, args in _random_calls(rng, s.doc):
        doc = None if name in ('guidelines', 'create_document', 'delete_entry', 'create_entry') else 'Story'
        toolkit.job_piece_call(s.ws, name, {**({'document': doc} if doc else {}), **args})
    staged = list(s.ws.ops)
    kept, proposed = s.decide()
    for op in kept:
        assert op['kind'] in jobapply.APPLIED_KINDS and op['kind'] not in jobapply.SETUP_KINDS, (seed, op)
    # Every op staged is applied or listed, nothing dropped: no sentence changed.
    assert len(kept) + len(proposed) == len([o for o in staged if o.get('kind') not in jobapply.IGNORED_KINDS])
    assert all(c['kind'] in jobapply.PROPOSED_KINDS for c in proposed), (seed, proposed)
    if not kept:
        return
    # Written through the plan's own executor in the job's stamp mode: no
    # call writes setup or removes a document, and every value written is
    # the job's unverified machine proposal.
    s.client.calls.clear()
    execute_plan(s.client, kept, source='service:igt:job:m', label='x', project=s.project, stamp_mode='machine',
                 detail={'model': 'm', 'version': 'v', 'job': J}, seed=str(__import__('plaid_client').uuid7()))
    stamped = 0
    for kind, payload in s.client.calls:
        assert not _FORBIDDEN.match(kind), (seed, kind, payload)
        for md in _stamps(kind, payload):
            stamped += 1
            assert _machine(md), (seed, kind, payload)
    assert stamped or not any(o['kind'] in ('set_span', 'set_analysis', 'link') and o.get('value', 'x')
                              for o in kept), (seed, kept)


def _stamps(kind, payload):
    """The metadata a write call stamps: a value, a token or a link made,
    a value rewritten (as path operations)."""
    if kind == 'spans.create':
        return [payload['args'][3]]
    if kind == 'tokens.create':
        return [payload['kwargs'].get('metadata') or {}]
    if kind == 'vocab_links.create':
        return [payload['args'][2]]
    if kind == 'spans.bulk_update':
        return [e['metadata'] for e in payload if 'value' in e]
    return []


def _machine(md):
    """Whether ``md`` makes the piece the job's unverified machine proposal."""
    if isinstance(md, list):
        sets = {tuple(o['path']): o.get('value') for o in md if o.get('op') == 'set'}
        dels = {tuple(o['path']) for o in md if o.get('op') == 'delete'}
        return sets.get(('prov',)) == 'inferred' and (sets.get(('provDetail',)) or {}).get('job') == J \
            and ('provConfirmed',) in dels
    return md.get('prov') == 'inferred' and (md.get('provDetail') or {}).get('job') == J \
        and not md.get('provConfirmed')
