"""A piece of a job planned in sentences starts with the evidence its model
would otherwise look up one form at a time (BRIEF-EV, igt/evidence.py): how
each form of its empty words was analysed before, the forms nobody analysed,
and the lexicon entries spelled inside them, bounded, read as the piece
starts. A piece of a document or selection plan is handed what it was."""

import re

import pytest

from fixtures import FakeClient, fake_ws, lexicon_raw
from job_fixtures import JobClient, Model, call, document, empty_words, reply, runner, start, use

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
        # Not "-di", stored with its marker: no morpheme links to it
        # (fit.form_key, test_link_form_rule).
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
        # One code path and one key with the evidence block (REV-DAY-P-16):
        # "ka," is looked up trimmed, as the block of a piece in sentences.
        assert '- "ka": people: ka ‘eat’ (1)' in asked[0], asked[0]


@pytest.mark.parametrize('plan', ['sentences', 'document'])
@pytest.mark.parametrize('word', ['Straße', 'λόγος', 'ﬁsh', 'gam'])
def test_a_form_people_analysed_is_found_whatever_its_case_folding(monkeypatch, plan, word):
    """REV-DAY-P-1: people's index and the decisions key a surface by
    fit.surface_key (casefold), and the block and the precedent look it up
    by the same key: "Straße", a final sigma and a ligature read as people
    analysed them, never "Analysed nowhere"."""
    client = JobClient({'A': document('A', 'Doc A', [{'words': [word.upper() if word != 'ﬁsh' else word]}]),
                        'P': document('P', 'Other', [{'words': [(word, [(word, 'x')], 'human')]}])})
    asked = _asked(monkeypatch, client, plan=plan)
    assert '": people: ' in asked[0] and '(1)' in asked[0], asked[0]
    assert evidence.NOWHERE_HEAD not in asked[0]


# --- the prompt lines (EV 3) -----------------------------------------------------

def _bullet(text, start):
    return next(b for b in text.split('\n- ') if b.startswith(start))


def test_a_piece_in_sentences_is_told_to_stage_first_in_no_more_words():
    from plaid_agent.igt import prompt
    project = fake_ws(FakeClient()).project
    from plaid_agent.igt import targets as tg
    fill = [t for t in tg.fillable(project) if t.id in ('segmentation', 'sl-mgloss')]
    sentences, other = prompt.build_job_prompt(project, sentences=True, targets=fill), prompt.build_job_prompt(project)
    old, new = _bullet(other, 'Use the tools rather than guessing.'), _bullet(sentences, 'The message says')
    # Empty words, never each sentence: a plan in sentences walks analysed
    # sentences too (EW), and analyze_sentence over one replaces people's
    # analyses (EV2).
    assert new == ('The message says what is empty in your piece, how those forms were '
                   'analysed and the lexicon entries in them. Stage the words to segment with analyze_sentence '
                   'first, and look up only what its answer lists as several or none.')
    assert 'Read before you write' not in sentences and 'concordance of "na"' not in sentences
    assert "It listed the entries na 'PRS' and ku 'INF'." in sentences
    other = other.split('\nRunning code:')[0]  # a piece in sentences has no code tool (EV 4)
    sentences = sentences.split('\nRunning code:')[0]
    assert len(sentences.split()) < len(other.split()), 'no new paragraph: lines replaced'
    # Built from its own parts: the find, read-budget and chat bullets go
    # (REV-DAY-P-8), never a line added.
    assert sentences.count('\n') < other.count('\n')


def test_each_piece_gets_the_prompt_of_its_plan(monkeypatch):
    seen = {}
    for plan in ('sentences', 'document'):
        job = start(_small(), id=J, documents=['A'], plan=plan)
        model = use(monkeypatch, Model(lambda asked, n, kwargs: reply('Done.')))
        run_job(job, runner(job))
        seen[plan] = model.calls[0]['kwargs']['messages'][0]['content']
    assert 'Stage the words to segment with analyze_sentence first' in seen['sentences']
    assert 'Read before you write' in seen['document'] and 'Stage the words' not in seen['document']


def test_the_planning_context_is_not_told_to_check_analyses_of_first():
    from plaid_agent.igt import prompt, toolkit
    from plaid_agent.igt.job import JobWorkspace
    ws = JobWorkspace(FakeClient(), fake_ws(FakeClient()).project, mode=JobWorkspace.PLAN)
    tools = toolkit.job_plan_tools(ws)
    analyses = next(t for t in tools if t['function']['name'] == 'analyses_of')
    assert 'Check this before' not in analyses['function']['description']
    assert analyses['function']['description'].startswith('How a form has been analyzed so far')
    text = prompt.build_plan_prompt(ws.project) + ' '.join(t['function']['description'] for t in tools)
    assert 'follow the majority' not in text and 'Check this before' not in text
    chat = next(t for t in toolkit.tools_for(ws) if t['function']['name'] == 'analyses_of')
    assert toolkit.CHECK_FIRST in chat['function']['description'], 'the chat keeps its tool as it was'


# --- the short tool list (EV 4) --------------------------------------------------

def test_a_piece_in_sentences_is_offered_the_short_list(monkeypatch):
    from plaid_agent.igt import toolkit
    seen = {}
    for plan in ('sentences', 'document'):
        job = start(_small(), id=J, documents=['A'], plan=plan)
        model = use(monkeypatch, Model(lambda asked, n, kwargs: reply('Done.')))
        run_job(job, runner(job))
        seen[plan] = [t['function']['name'] for t in model.calls[0]['kwargs']['tools']]
    # The sentence tools only when the plan edits the text (FX).
    assert seen['sentences'] == ['read_lexicon', 'set_field', 'set_analysis', 'analyze_sentence', 'link_entry',
                                 'create_entry', 'analyses_of']
    from plaid_agent.igt import targets as tg
    glossing = [t for t in tg.fillable(fake_ws(FakeClient()).project) if t.id in ('segmentation', 'sl-mgloss')]
    assert set(seen['sentences']) == set(toolkit.sentences_piece_tools(glossing)) - set(toolkit.TEXT_TOOLS)
    assert 'concordance' in seen['document'] and len(seen['document']) > 50, 'a document piece keeps its tools'


def test_a_tool_off_the_short_list_is_refused():
    from plaid_agent.igt import toolkit
    from plaid_agent.igt.job import JobWorkspace
    from plaid_agent.igt import targets as tg
    ws = JobWorkspace(FakeClient(), fake_ws(FakeClient()).project)
    ws.in_sentences = True
    ws.fills = [t for t in tg.fillable(ws.project) if t.id in ('segmentation', 'sl-mgloss')]
    out = toolkit.job_piece_call(ws, 'concordance', {'pattern': 'gam'})
    assert str(out).startswith('Error') and "not one of this job's" in out
    assert {t['function']['name'] for t in toolkit.job_piece_tools(ws, plan_only=True)} == {
        'set_field', 'set_analysis', 'analyze_sentence', 'link_entry', 'create_entry'}
    ws.edits_text = True
    assert {t['function']['name'] for t in toolkit.job_piece_tools(ws, plan_only=True)} == {
        'set_field', 'set_analysis', 'analyze_sentence', 'link_entry', 'create_entry', 'split_sentence',
        'merge_sentences', 'delete_sentence', 'retype_sentence'}


# --- a scripted piece that stages from the block alone (EV 6) ----------------------

def from_block(asked):
    """A scripted model's items for the piece's first sentence, read from the
    evidence block alone: a form people analysed as they did, else a whole
    form an entry spells with that entry's gloss, else left ("_")."""
    import re as _re
    analysed, entries = {}, {}
    for line in asked.split('\n'):
        m = _re.match(r'- "(.*)": people: (\S+) ‘(.*?)’', line)
        if m:
            analysed[m.group(1)] = f'{m.group(2)} {m.group(3)}'
        m = _re.match(r'^([^\s#‘]+)(?:#\S+)? ‘(.*?)’', line)
        if m and not line.startswith(('- ', 'How ', 'Lexicon ')):
            entries.setdefault(m.group(1).lower(), m.group(2))
    items = []
    for surface in [f for s, words in empty_words(asked) if s == 1 for _, f in words]:
        form = evidence.form_of(surface, None).strip(',.')
        items.append(analysed.get(form) or (f'{form} {entries[form]}' if form in entries else '_'))
    return items


def test_a_scripted_piece_stages_on_its_first_call_from_the_block_alone(monkeypatch):
    from plaid_agent.igt import job as igt_job
    client = JobClient({'A': document('A', 'Doc A', [{'words': ['gam', 'ka,', 'zo']}]),
                        'P': document('P', 'Other', [{'words': [('ka', [('ka', 'eat')], 'human')]}])})
    staged = {}

    def answer(asked, n, kwargs):
        if n == 1:
            staged['items'] = from_block(asked)
            return reply(calls=[call(1, 'analyze_sentence', {'document': 'Doc A', 'sentences': [
                {'ref': 's1', 'words': staged['items']}]})])
        return reply('Glossed s1.')
    real, sent = igt_job.execute_plan, []

    def execute(c, ops, **kw):
        sent.extend(ops)
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    asked = _asked(monkeypatch, client, answer=answer)
    assert len(asked) == 1
    assert staged['items'] == ['gam fish', 'ka eat', '_']
    assert sorted(o['kind'] for o in sent) == ['link', 'set_analysis', 'set_analysis'], sent
    assert [o['item_id'] for o in sent if o['kind'] == 'link'] == ['vi-gam'], 'gam fish fits one entry'


# --- a piece that fills a field on analysed text (EV2) -----------------------------

def test_a_piece_filling_a_field_on_analysed_text_is_offered_set_field_and_handed_no_evidence(monkeypatch):
    """A plan in sentences walks analysed sentences too (EW). A piece whose
    sentences have nothing empty is offered set_field, the tool that sets a
    word field, and handed no evidence block: the block is of its empty
    words, and it has none. Its prompt says to stage empty words, never each
    sentence, since analyze_sentence over an analysed one replaces it."""
    import test_job_fields as F
    client, job, model, written = F._job(monkeypatch, 'sentences')
    run_job(job, runner(job))
    first = next(c for c in model.calls if c['n'] == 1 and 'Instructions from' in c['asked'])
    names = [t['function']['name'] for t in first['kwargs']['tools']]
    # What the plan fills decides the tools: a word field, not linked to the
    # lexicon, so the field tool and the two reads (the owner's steer).
    assert sorted(names) == ['analyses_of', 'read_lexicon', 'set_field']
    asked = first['asked']
    assert 'Empty in s1: Thematic role in w1' in asked
    assert 'How these forms were analysed before' not in asked and 'Lexicon entries spelled inside' not in asked
    assert 'Analysed nowhere before' not in asked
    system = first['kwargs']['messages'][0]['content']
    assert 'analyze_sentence' not in system and 'Fill what is empty with set_field.' in system
    assert len(written) == F.VALUES
