"""A piece of a job planned in sentences starts with the evidence its model
would otherwise look up one form at a time (BRIEF-EV, igt/evidence.py): how
each form of its empty words was analysed before, the forms nobody analysed,
and the lexicon entries spelled inside them, bounded, read as the piece
starts. A piece of a document or selection plan is handed what it was."""

import re

import pytest

from fixtures import FakeClient, fake_ws, lexicon_raw
from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.core.job import run_job
from plaid_agent.igt import evidence

J = 'JE'


def _asked(monkeypatch, client, plan='sentences', answer=None):
    """Every message the job's model was sent."""
    job = start(client, id=J, documents=['A'], plan=plan)
    model = use(monkeypatch, Model(answer or (lambda asked, n, kwargs: reply('Done.'))))
    run_job(job, runner(job))
    return [c['asked'] for c in model.calls if c['n'] == 1]


def _small(plan='sentences'):
    """Doc A, one blank sentence "Gamdi ka, zo", and another document where a
    person analysed ka as eat. The lexicon: Ali, -di ERG, gam fish, gam net."""
    return JobClient({'A': document('A', 'Doc A', [{'words': ['Gamdi', 'ka,', 'zo']}]),
                      'P': document('P', 'Other', [{'words': [('ka', [('ka', 'eat')], 'human')]}])})


def test_the_block_of_a_small_piece_exactly(monkeypatch):
    asked = _asked(monkeypatch, _small())
    assert len(asked) == 1
    block = asked[0].split('\n\nInstructions from')[0].split('Empty in s1: ')[1].split('\n\n', 1)[1]
    assert block == '\n'.join([
        'How these forms were analysed before (by people in this project, and earlier in this job):',
        '- "ka": people: ka ‘eat’ (1)',
        'Analysed nowhere before: gamdi, zo.',
        'Lexicon entries spelled inside these forms (form ‘gloss’ type):',
        '-di ‘ERG’ suffix',
        'gam#1 ‘fish’',
        'gam#2 ‘net’',
    ]), block


def _big_lexicon(n):
    """``n`` entries spelled inside "abcdefghij", of every length from 1."""
    word = 'abcdefghij'
    items, i = [], 0
    for size in range(1, len(word) + 1):
        for start_at in range(0, len(word) - size + 1):
            items.append({'id': f'e{i}', 'form': word[start_at:start_at + size], 'metadata': {'gloss': f'g{i}'}})
            i += 1
            if i == n:
                return {**lexicon_raw(), 'items': items}
    return {**lexicon_raw(), 'items': items}


def _entries(text):
    return [line.split(' ')[0] for line in text.split('\n') if re.search(r' ‘g\d+’$', line)]


def test_the_block_keeps_to_its_budget_and_cuts_the_shortest_entries_first():
    client = FakeClient(lexicon=_big_lexicon(55))
    ws = fake_ws(client)
    whole = evidence.block(ws, ws.project, ['abcdefghij'], {}, {}, str)
    assert len(_entries(whole)) == 55 and 'Left out' not in whole
    cut = evidence.block(ws, ws.project, ['abcdefghij'], {}, {}, str, budget=600)
    assert len(cut) <= 600
    kept = _entries(cut)
    left = 55 - len(kept)
    assert left > 0
    # The shortest forms went first: every one kept is at least as long as every one left out.
    assert min(len(k) for k in kept) >= max(len(it['form']) for it in _big_lexicon(55)['items']
                                           if it['form'] not in kept)
    lengths = sorted({len(it['form']) for it in _big_lexicon(55)['items'] if it['form'] not in kept})
    assert lengths[0] == 1
    assert cut.split('\n')[-1] == (f'Left out for length: {left} lexicon entries of 1 to {lengths[-1]} letters '
                                   '(read_lexicon finds them).')


def test_with_no_room_for_entries_the_analysed_forms_go_from_the_last():
    client = FakeClient(lexicon=_big_lexicon(10))
    ws = fake_ws(client)
    people = {f'w{i}': {'k': {'analysis': {'morphemes': []}, 'count': 1}} for i in range(1, 40)}
    out = evidence.block(ws, ws.project, [f'w{i}' for i in range(1, 40)], people, {},
                         lambda a: 'some analysis ‘gloss’', budget=500)
    assert len(out) <= 500
    lines = out.split('\n')
    assert lines[0] == evidence.ANALYSED_HEAD and lines[1].startswith('- "w1": ')
    assert not _entries(out), 'no room for an entry'
    assert lines[-1].startswith('Left out for length: ') and lines[-1].endswith(
        'were analysed (analyses_of reads them).')


class _Lexicon(JobClient):
    """A client whose lexicon reads answer ``made`` once anything was
    written, as documents answer ``after_write``: the lexicon the job's
    write left."""

    @property
    def _lexicon(self):
        return self.made if self.writes and getattr(self, 'made', None) else self._before

    @_lexicon.setter
    def _lexicon(self, value):
        self._before = value


def test_the_bound_holds_however_many_forms_nobody_analysed():
    ws = fake_ws(FakeClient(lexicon=_big_lexicon(3)))
    out = evidence.block(ws, ws.project, [f'zz{i}' for i in range(500)], {}, {}, str, budget=400)
    assert len(out) <= 400
    assert out.startswith('Analysed nowhere before: zz0, zz1, ') and ' more.' in out.split('\n')[0]


def test_a_later_piece_sees_what_an_earlier_one_wrote(monkeypatch):
    """The block is read as each piece starts: the entry the first piece's
    write made and the analysis it wrote are in the second piece's block."""
    client = _Lexicon({'A': document('A', 'Doc A', [{'words': [f'ka{i}', 'tam']} for i in range(1, 7)])})
    client.made = {**lexicon_raw(), 'items': lexicon_raw()['items'] + [
        {'id': 'e-tam', 'form': 'tam', 'metadata': {'gloss': 'stone', 'status': 'machine'}}]}
    client.after_write['A'] = document('A', 'Doc A', [
        {'words': [('ka1', [('ka1', 'x')], J), ('tam', [('tam', 'stone', 'e-tam')], J)]}]
        + [{'words': [f'ka{i}', 'tam']} for i in range(2, 7)])

    def answer(asked, n, kwargs):
        if 'Your piece: s1,' in asked and n == 1:
            return reply(calls=[call(1, 'analyze_sentence', {'document': 'Doc A', 'sentences': [
                {'ref': 's1', 'words': ['ka1 x', 'tam stone']}], 'new_entries': True})])
        return reply('Done.')
    asked = _asked(monkeypatch, client, answer=answer)
    first, second = asked[0], asked[1]
    assert 'Your piece: s1, s2, s3, s4, s5.' in first and 'Your piece: s6.' in second
    assert 'tam ‘stone’' not in first and 'Analysed nowhere before: ka1, tam, ka2, ka3, ka4, ka5.' in first
    assert '- "tam": this job: tam ‘stone’ (entries tam) (1)' in second, second
    assert 'Analysed nowhere before: ka6.' in second
    assert '\ntam ‘stone’\n' in second + '\n', second


@pytest.mark.parametrize('plan', ['document', 'selection'])
def test_a_piece_of_a_document_or_selection_plan_gets_the_precedent_as_before(monkeypatch, plan):
    asked = _asked(monkeypatch, _small(), plan=plan)
    assert asked
    for text in asked:
        assert evidence.ENTRIES_HEAD not in text and evidence.NOWHERE_HEAD not in text
    if plan == 'document':
        assert '- "ka,": people' not in asked[0] and 'How these forms were analysed before' not in asked[0], \
            'the precedent keys a form by its surface as typed, as it did'
