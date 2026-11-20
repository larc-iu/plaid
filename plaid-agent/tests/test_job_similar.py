"""A piece of a job planned in sentences that segments or fills a morpheme
field is handed the sentences of the project most like its own, as people
analysed them (BRIEF-SS, igt/similar.py): after the evidence block, the most
alike last, within JOB_SIMILAR_CHARS, never one of the piece's own sentences,
never one the job wrote in, each word with its forms and the morpheme fields
the job fills, and none for a job that fills neither."""

import time

import pytest

from fixtures import GLOSS, MGLOSS, MORPH_LAYER, TRANS
from job_fixtures import (MPOS, ROLE, JobClient, Model, document, fields_project, reply, runner, start, use,
                          with_values)

from plaid_agent.core.job import run_job
from plaid_agent.core.limits import JOB_SIMILAR_CHARS, JOB_SIMILAR_SENTENCES
from plaid_agent.igt import similar
from plaid_agent.igt.prompt import JOB_STAGE_SIMILAR

J = 'JS'


def _run(monkeypatch, client, fills=None):
    """The first message and system prompt of every piece, in order."""
    job = start(client, id=J, documents=['A'], **({'fills': fills} if fills else {}))
    model = use(monkeypatch, Model(lambda asked, n, kwargs: reply('Done.')))
    run_job(job, runner(job))
    return [(c['asked'], c['kwargs']['messages'][0]['content']) for c in model.calls if c['n'] == 1]


def _block(asked):
    if similar.HEAD not in asked:
        return ''
    return similar.HEAD + asked.split(similar.HEAD, 1)[1].split('\n\nInstructions from', 1)[0]


def _people():
    """Another document people analysed: "gamdi ka." (the stem gam of the
    piece's "gamda"), with its translation, and an unrelated "lili mumu."."""
    return document('P', 'Other', [
        {'words': [('gamdi', [('gam', 'fish'), ('di', 'ERG')], 'human'), ('ka', [('ka', 'eat')], 'human')],
         'translation': ('The fish ate.', 'human')},
        {'words': [('lili', [('lili', 'sing')], 'human'), ('mumu', [('mu', 'REP'), ('mu', 'REP')], 'human')]}])


# --- the rule (its own unit tests) ------------------------------------------------

def _pool(*sentences):
    return similar.Pool([similar.features(s.split()) for s in sentences])


def test_a_pool_sentence_sharing_a_stem_with_an_unseen_form_ranks_over_an_unrelated_one():
    pool = _pool('lili mumu', 'gamdi ka', 'zozo tete')
    assert pool.ranked(similar.features(['gamda']), 1) == [1]


def test_ties_go_by_document_order_and_round_robin_takes_each_sentences_nearest_first():
    pool = _pool('ka', 'ka', 'zo', 'zo', 'ta')
    # Two queries: each one's nearest, then each one's second.
    assert similar.pick(pool, [similar.features(['ka']), similar.features(['zo'])], k=4) == [0, 2, 1, 3]
    assert similar.pick(pool, [similar.features(['ka'])], k=2, skip=frozenset({0})) == [1, 2]


def _analysis(form, gloss):
    return {'morphemes': [{'form': form, 'equals': False, 'fields': {'Morph Gloss': gloss}}], 'word': {}}


def test_the_cut_at_the_budget_drops_the_least_similar():
    examples = [{'text': f'sentence {i}.', 'words': [_analysis(f'w{i}', f'g{i}')]} for i in range(3)]
    whole = similar.block(examples)
    assert whole.split('\n\n') == [similar.HEAD, *(similar.lines_of(x) for x in examples[::-1])]
    cut = similar.block(examples, budget=len(whole) - 1)
    assert len(cut) < len(whole)
    # The last taken (least alike, shown first) went; the most alike is still last.
    assert cut.split('\n\n') == [similar.HEAD, similar.lines_of(examples[1]), similar.lines_of(examples[0])]
    assert similar.block(examples, budget=10) == ''


# --- through the worker ----------------------------------------------------------

def test_the_block_of_a_small_piece_exactly(monkeypatch):
    client = JobClient({'A': document('A', 'Doc A', [{'words': ['gamda', 'zo']}]), 'P': _people()})
    (asked, system), = _run(monkeypatch, client)
    assert _block(asked) == '\n'.join([
        similar.HEAD,
        '',
        'lili mumu.',
        'Words: ["lili sing", "mu-mu REP-REP"]',
        '',
        'gamdi ka.',
        'Translation: The fish ate.',
        'Words: ["gam-di fish-ERG", "ka eat"]',
    ]), asked
    # It follows the evidence block.
    assert asked.index('Analysed nowhere before: gamda, zo.') < asked.index(similar.HEAD)
    assert JOB_STAGE_SIMILAR in system


def test_the_pieces_own_sentences_never_appear(monkeypatch):
    """s2 is analysed and in the piece: never in its list. s7, analysed and
    in another piece, is."""
    sentences = [{'words': ['gamda']}, {'words': [('gamdo', [('gam', 'fish'), ('do', 'LOC')], 'human')]}]
    sentences += [{'words': [f'ta{i}']} for i in range(3, 7)]
    sentences += [{'words': [('gamdu', [('gam', 'fish'), ('du', 'ALL')], 'human')]}]
    client = JobClient({'A': document('A', 'Doc A', sentences)})
    pieces = _run(monkeypatch, client)
    first = _block(pieces[0][0])
    assert 'Your piece: s1, s2, s3, s4, s5.' in pieces[0][0]
    assert 'gamdo' not in first and 'gamdu.' in first, first


def test_a_sentence_the_job_wrote_in_is_not_in_the_pool(monkeypatch):
    """People analysed the words, the job wrote its translation: not
    people's sentence."""
    people = document('P', 'Other', [
        {'words': [('gamdi', [('gam', 'fish'), ('di', 'ERG')], 'human')], 'translation': ('By the job.', J)},
        {'words': [('gamdo', [('gam', 'fish'), ('do', 'LOC')], 'human')]}])
    client = JobClient({'A': document('A', 'Doc A', [{'words': ['gamda']}]), 'P': people})
    (asked, _), = _run(monkeypatch, client)
    block = _block(asked)
    assert 'gamdo.' in block and 'gamdi' not in block, block


def test_a_job_that_fills_only_a_translation_gets_no_block(monkeypatch):
    client = JobClient({'A': document('A', 'Doc A', [{'words': ['gamda', 'zo']}]), 'P': _people()})
    pieces = _run(monkeypatch, client, fills=(TRANS,))
    assert pieces
    for asked, system in pieces:
        assert similar.HEAD not in asked and JOB_STAGE_SIMILAR not in system


# --- the columns follow what the job fills ------------------------------------------

def _people_pos():
    """:func:`_people` in the project with Morph POS, each morpheme given a
    person's POS but "ka"'s."""
    return with_values(_people(), [(MPOS, 'P-s1w1m1', 'N', 'human'), (MPOS, 'P-s1w1m2', 'CASE', 'human'),
                                   (MPOS, 'P-s2w1m1', 'V', 'human'), (MPOS, 'P-s2w2m1', 'RED', 'human'),
                                   (MPOS, 'P-s2w2m2', 'RED', 'human')])


def _pos_client():
    return JobClient({'A': document('A', 'Doc A', [{'words': ['gamda', 'zo']}]), 'P': _people_pos()},
                     project=fields_project())


def test_a_job_that_segments_and_fills_two_morpheme_fields_sees_both_and_the_columns_named(monkeypatch):
    (asked, system), = _run(monkeypatch, _pos_client(), fills=('segmentation', MGLOSS, MPOS))
    assert _block(asked) == '\n'.join([
        similar.HEAD,
        'Columns of the words: ["forms", "gloss", "Morph POS"]',
        '',
        'lili mumu.',
        'Words: ["lili sing V", "mu-mu REP-REP RED-RED"]',
        '',
        'gamdi ka.',
        'Translation: The fish ate.',
        'Words: ["gam-di fish-ERG N-CASE", "ka eat _"]',
    ]), asked
    assert JOB_STAGE_SIMILAR in system


def test_a_job_that_fills_a_morpheme_field_not_the_gloss_sees_it_and_not_the_gloss(monkeypatch):
    (asked, system), = _run(monkeypatch, _pos_client(), fills=(MPOS,))
    block = _block(asked)
    assert block.split('\n')[1] == 'Columns of the words: ["forms", "Morph POS"]', block
    assert [x for x in block.split('\n') if x.startswith('Words: ')] == [
        'Words: ["lili V", "mu-mu RED-RED"]', 'Words: ["gam-di N-CASE", "ka _"]'], block
    assert JOB_STAGE_SIMILAR in system


def test_a_job_that_fills_a_morpheme_field_on_segmented_words_gets_the_block(monkeypatch):
    """Nothing is empty for segmentation: "gamda" is segmented, its gloss
    empty. The one default field renders as analyze_sentence takes it by
    default, no columns line."""
    client = JobClient({'A': document('A', 'Doc A', [{'words': [('gamda', [('gam', None), ('da', None)], 'human')]}]),
                        'P': _people()})
    (asked, system), = _run(monkeypatch, client, fills=(MGLOSS,))
    assert _block(asked) == '\n'.join([
        similar.HEAD,
        '',
        'lili mumu.',
        'Words: ["lili sing", "mu-mu REP-REP"]',
        '',
        'gamdi ka.',
        'Translation: The fish ate.',
        'Words: ["gam-di fish-ERG", "ka eat"]',
    ]), asked
    assert JOB_STAGE_SIMILAR in system


def test_a_job_that_only_segments_sees_forms_alone(monkeypatch):
    (asked, _), = _run(monkeypatch, _pos_client(), fills=('segmentation',))
    block = _block(asked)
    assert block.split('\n')[1] == '' and [x for x in block.split('\n') if x.startswith('Words: ')] == [
        'Words: ["lili", "mu-mu"]', 'Words: ["gam-di", "ka"]'], block


def test_a_job_whose_morpheme_fields_are_full_in_the_piece_gets_no_block(monkeypatch):
    """Segmented and glossed by people: nothing in the piece is empty for
    the job's morpheme field, so no sentence ranks the pool, though the
    translation is empty."""
    client = JobClient({'A': document('A', 'Doc A', [{'words': [('gamda', [('gam', 'fish'), ('da', 'x')], 'human')]}]),
                        'P': _people()})
    pieces = _run(monkeypatch, client, fills=(MGLOSS, TRANS))
    assert pieces
    for asked, system in pieces:
        assert similar.HEAD not in asked and JOB_STAGE_SIMILAR not in system, asked


# --- word fields: a line each under the words -----------------------------------------

def _renamed(project, names):
    """``project`` (raw) with the fields of ``names`` (layer id -> name)
    renamed."""
    for tk in project['text_layers'][0]['token_layers']:
        for sl in tk['span_layers']:
            if sl['id'] in names:
                sl['name'] = names[sl['id']]
    return project


def _animacy_client(piece):
    """fields_project with its word field Role named Animacy, the piece's
    document ``piece`` (sentences) and :func:`_people` with "gamdi"
    animate."""
    return JobClient({'A': document('A', 'Doc A', piece),
                      'P': with_values(_people(), [(ROLE, 'P-s1w1', 'animate', 'human')])},
                     project=_renamed(fields_project(), {ROLE: 'Animacy'}))


def test_a_job_that_fills_a_word_field_on_segmented_words_gets_the_block_exactly(monkeypatch):
    """Nothing is empty for segmentation, Animacy is: the words show their
    forms alone, the field a line under them, "_" for a word with none.
    "lili mumu." holds no Animacy: a job that fills only word fields is not
    handed it."""
    client = _animacy_client([{'words': [('gamda', [('gam', 'fish'), ('da', 'x')], 'human'),
                                         ('zo', [('zo', 'y')], 'human')]}])
    (asked, system), = _run(monkeypatch, client, fills=(ROLE,))
    assert _block(asked) == '\n'.join([
        similar.HEAD,
        '',
        'gamdi ka.',
        'Translation: The fish ate.',
        'Words: ["gam-di", "ka"]',
        'Animacy: ["animate", "_"]',
    ]), asked
    assert JOB_STAGE_SIMILAR in system


def test_a_job_that_segments_glosses_and_fills_a_word_field_sees_its_columns_and_the_fields_line(monkeypatch):
    (asked, system), = _run(monkeypatch, _animacy_client([{'words': ['gamda', 'zo']}]),
                            fills=('segmentation', MGLOSS, ROLE))
    assert _block(asked) == '\n'.join([
        similar.HEAD,
        '',
        'lili mumu.',
        'Words: ["lili sing", "mu-mu REP-REP"]',
        'Animacy: ["_", "_"]',
        '',
        'gamdi ka.',
        'Translation: The fish ate.',
        'Words: ["gam-di fish-ERG", "ka eat"]',
        'Animacy: ["animate", "_"]',
    ]), asked
    assert JOB_STAGE_SIMILAR in system


def test_a_word_field_not_a_target_is_never_shown(monkeypatch):
    """Animacy holds a value in the pool, the job glosses: no line of it."""
    (asked, _), = _run(monkeypatch, _animacy_client([{'words': ['gamda', 'zo']}]), fills=('segmentation', MGLOSS))
    block = _block(asked)
    assert block and 'Animacy' not in block, block


def test_word_field_lines_go_in_target_order(monkeypatch):
    """Two word fields, named in the plan Gloss then Animacy: their lines in
    that order, each its own values."""
    people = with_values(document('P', 'Other', [
        {'words': [{'form': 'gamdi', 'morphs': [('gam', 'fish'), ('di', 'ERG')], 'who': 'human',
                    'gloss': ('fish.ERG', 'human')}, ('ka', [('ka', 'eat')], 'human')]}]),
        [(ROLE, 'P-s1w2', 'act', 'human')])
    client = JobClient({'A': document('A', 'Doc A', [{'words': ['gamda']}]), 'P': people},
                       project=fields_project())
    (asked, _), = _run(monkeypatch, client, fills=(GLOSS, ROLE))
    assert _block(asked).split('\n')[-2:] == ['Gloss: ["fish.ERG", "_"]', 'Role: ["_", "act"]'], asked


def _one_name_people():
    """:func:`_people` with "gamdi" given a word gloss and a word Role, and
    Morph POS on its morphemes: values that differ from its morphemes'
    glosses, so a swap shows."""
    raw = document('P', 'Other', [
        {'words': [{'form': 'gamdi', 'morphs': [('gam', 'fish'), ('di', 'ERG')], 'who': 'human',
                    'gloss': ('fish.ERG', 'human')}, ('ka', [('ka', 'eat')], 'human')],
         'translation': ('The fish ate.', 'human')}])
    return with_values(raw, [(ROLE, 'P-s1w1', 'agent', 'human'), (MPOS, 'P-s1w1m1', 'N', 'human'),
                             (MPOS, 'P-s1w1m2', 'CASE', 'human')])


def test_a_word_field_and_a_morpheme_field_both_named_gloss_are_each_under_their_own_name(monkeypatch):
    """The morpheme gloss field named Gloss, as the word gloss field is: the
    project shows them as "Gloss (Morpheme)" and "Gloss (Word)". The morpheme
    one is the gloss column of the words, the word one its own line."""
    client = JobClient({'A': document('A', 'Doc A', [{'words': ['gamda', 'zo']}]), 'P': _one_name_people()},
                       project=_renamed(fields_project(), {MGLOSS: 'Gloss'}))
    (asked, _), = _run(monkeypatch, client, fills=('segmentation', MGLOSS, GLOSS))
    assert _block(asked) == '\n'.join([
        similar.HEAD,
        '',
        'gamdi ka.',
        'Translation: The fish ate.',
        'Words: ["gam-di fish-ERG", "ka eat"]',
        'Gloss (Word): ["fish.ERG", "_"]',
    ]), asked


def test_a_word_field_and_a_morpheme_field_of_one_other_name_are_never_swapped(monkeypatch):
    """Morph POS renamed Role, as the word field is: "Role (Morpheme)" a
    column of the words, "Role (Word)" its own line."""
    client = JobClient({'A': document('A', 'Doc A', [{'words': ['gamda', 'zo']}]), 'P': _one_name_people()},
                       project=_renamed(fields_project(), {MPOS: 'Role'}))
    (asked, _), = _run(monkeypatch, client, fills=(ROLE, MPOS))
    assert _block(asked) == '\n'.join([
        similar.HEAD,
        'Columns of the words: ["forms", "Role (Morpheme)"]',
        '',
        'gamdi ka.',
        'Translation: The fish ate.',
        'Words: ["gam-di N-CASE", "ka _"]',
        'Role (Word): ["agent", "_"]',
    ]), asked


def test_a_word_field_full_in_the_piece_gets_no_block(monkeypatch):
    """Every word of the piece holds Animacy: no sentence ranks the pool."""
    piece = with_values(document('A', 'Doc A', [{'words': ['gamda', 'zo']}]),
                        [(ROLE, 'A-s1w1', 'animate', 'human'), (ROLE, 'A-s1w2', 'inanimate', 'human')])
    client = JobClient({'A': piece, 'P': with_values(_people(), [(ROLE, 'P-s1w1', 'animate', 'human')])},
                       project=_renamed(fields_project(), {ROLE: 'Animacy'}))
    pieces = _run(monkeypatch, client, fills=(ROLE, TRANS))
    assert pieces
    for asked, system in pieces:
        assert similar.HEAD not in asked and JOB_STAGE_SIMILAR not in system, asked


def test_the_cut_counts_the_word_field_lines():
    """At a budget all three examples fit without their word field line,
    the least alike is dropped once the lines are shown."""
    examples = [{'text': f'sentence {i}.', 'words': [{**_analysis(f'w{i}', f'g{i}'), 'word': {'Animacy': 'animate'}}]}
                for i in range(3)]
    shown = [similar.lines_of(x, word_fields=['Animacy']) for x in examples]
    assert shown[0].split('\n')[-1] == 'Animacy: ["animate"]'
    budget = len(similar.HEAD) + sum(len(x) + 2 for x in shown[:2])
    assert similar.block(examples, budget=budget).count('Words: ') == 3
    cut = similar.block(examples, word_fields=['Animacy'], budget=budget)
    assert cut.split('\n\n') == [similar.HEAD, shown[1], shown[0]]
    assert len(cut) == budget


def test_a_word_with_no_morphemes_shows_its_surface():
    """A word of a project with no morpheme layer has no morphemes: its
    surface stands for its forms."""
    example = {'text': 'gamdi ka.', 'words': [{'morphemes': [], 'word': {'Animacy': 'animate'}, 'surface': 'gamdi'},
                                              {'morphemes': [], 'word': {}, 'surface': 'ka'}]}
    assert similar.lines_of(example, word_fields=['Animacy']) == '\n'.join([
        'gamdi ka.', 'Words: ["gamdi", "ka"]', 'Animacy: ["animate", "_"]'])


# --- word fields where nothing is segmented ------------------------------------------

def _unsegmented_people():
    """Another document nobody segmented: "gamdi ka." with a person's
    Animacy on "gamdi", "lili mumu." with none, "gamdo zo." whose only
    Animacy the job wrote, "gamdu zu." whose only Animacy another producer
    proposed and nobody confirmed."""
    raw = document('P', 'Other', [{'words': ['gamdi', 'ka'], 'translation': ('The fish ate.', 'human')},
                                  {'words': ['lili', 'mumu']}, {'words': ['gamdo', 'zo']},
                                  {'words': ['gamdu', 'zu']}])
    return with_values(raw, [(ROLE, 'P-s1w1', 'animate', 'human'), (ROLE, 'P-s3w1', 'animate', J),
                             (ROLE, 'P-s4w1', 'animate', 'machine')])


def _animacy_project():
    return _renamed(fields_project(), {ROLE: 'Animacy'})


def test_a_word_field_job_where_nothing_is_segmented_gets_the_block_exactly(monkeypatch):
    """Only "gamdi ka." holds a person's Animacy: the sentence with none,
    the one whose only value the job wrote and the one whose only value is
    another producer's are not in it. Each unsegmented word shows its
    surface."""
    client = JobClient({'A': document('A', 'Doc A', [{'words': ['gamda', 'zo']}]), 'P': _unsegmented_people()},
                       project=_animacy_project())
    (asked, system), = _run(monkeypatch, client, fills=(ROLE,))
    assert _block(asked) == '\n'.join([
        similar.HEAD,
        '',
        'gamdi ka.',
        'Translation: The fish ate.',
        'Words: ["gamdi", "ka"]',
        'Animacy: ["animate", "_"]',
    ]), asked
    assert JOB_STAGE_SIMILAR in system


def test_a_word_field_job_never_sees_its_pieces_own_sentences(monkeypatch):
    """s2 holds a person's Animacy and is in the piece: never in its list.
    s7, in another piece, is."""
    sentences = [{'words': ['gamda']}, {'words': ['gamdo']}] + [{'words': [f'ta{i}']} for i in range(3, 7)]
    sentences += [{'words': ['gamdu']}]
    doc = with_values(document('A', 'Doc A', sentences),
                      [(ROLE, 'A-s2w1', 'animate', 'human'), (ROLE, 'A-s7w1', 'animate', 'human')])
    pieces = _run(monkeypatch, JobClient({'A': doc}, project=_animacy_project()), fills=(ROLE,))
    first = _block(pieces[0][0])
    assert 'Your piece: s1, s2, s3, s4, s5.' in pieces[0][0]
    assert 'gamdo' not in first and 'gamdu.' in first, first


def test_a_job_filling_two_word_fields_counts_a_sentence_holding_either(monkeypatch):
    people = with_values(document('P', 'Other', [
        {'words': ['gamdi', 'ka']},
        {'words': [{'form': 'gamdo', 'who': 'human', 'gloss': ('fish.LOC', 'human')}, 'zo']},
        {'words': ['gamdu', 'zu']}]), [(ROLE, 'P-s1w2', 'act', 'human')])
    client = JobClient({'A': document('A', 'Doc A', [{'words': ['gamda', 'zo']}]), 'P': people},
                       project=fields_project())
    (asked, _), = _run(monkeypatch, client, fills=(GLOSS, ROLE))
    block = _block(asked)
    assert 'gamdi ka.' in block and 'gamdo zo.' in block and 'gamdu' not in block, block
    assert 'Gloss: ["fish.LOC", "_"]' in block and 'Role: ["_", "act"]' in block, block


def test_a_job_that_segments_and_fills_a_word_field_keeps_the_analysed_pool(monkeypatch):
    """"gamdo zo." holds a person's Animacy, its words unsegmented: not in
    the block of a job that segments, which is today's."""
    people = document('P', 'Other', [
        {'words': [('gamdi', [('gam', 'fish'), ('di', 'ERG')], 'human'), ('ka', [('ka', 'eat')], 'human')],
         'translation': ('The fish ate.', 'human')},
        {'words': ['gamdo', 'zo']}])
    client = JobClient({'A': document('A', 'Doc A', [{'words': ['gamda', 'zo']}]),
                        'P': with_values(people, [(ROLE, 'P-s1w1', 'animate', 'human'),
                                                  (ROLE, 'P-s2w1', 'animate', 'human')])},
                       project=_animacy_project())
    (asked, _), = _run(monkeypatch, client, fills=('segmentation', ROLE))
    assert _block(asked) == '\n'.join([
        similar.HEAD,
        '',
        'gamdi ka.',
        'Translation: The fish ate.',
        'Words: ["gam-di", "ka"]',
        'Animacy: ["animate", "_"]',
    ]), asked


def test_a_word_field_job_gives_the_same_list_twice(monkeypatch):
    def make():
        docs = {'A': document('A', 'Doc A', [{'words': ['gamda', 'zo']}, {'words': ['kada']}])}
        for d in range(3):
            docs[f'P{d}'] = with_values(
                document(f'P{d}', f'Other {d}', [{'words': [f'{w}{d}{i}' for w in ('gam', 'ka', 'zo')]}
                                                 for i in range(12)]),
                [(ROLE, f'P{d}-s{i}w2', 'animate', 'human') for i in range(1, 13)])
        return JobClient(docs, project=_animacy_project())
    first = _block(_run(monkeypatch, make(), fills=(ROLE,))[0][0])
    second = _block(_run(monkeypatch, make(), fills=(ROLE,))[0][0])
    assert first and first == second
    assert first.count('Words: ') == JOB_SIMILAR_SENTENCES


def test_no_pool_no_block_and_the_prompt_says_nothing_of_it(monkeypatch):
    client = JobClient({'A': document('A', 'Doc A', [{'words': ['gamda', 'zo']}])})
    (asked, system), = _run(monkeypatch, client)
    assert similar.HEAD not in asked and JOB_STAGE_SIMILAR not in system


def test_the_same_project_gives_the_same_list_twice(monkeypatch):
    def make():
        docs = {'A': document('A', 'Doc A', [{'words': ['gamda', 'zo']}, {'words': ['kada']}])}
        for d in range(3):
            docs[f'P{d}'] = document(f'P{d}', f'Other {d}', [
                {'words': [(f'{w}{d}{i}', [(f'{w}{d}{i}', 'x')], 'human') for w in ('gam', 'ka', 'zo')]}
                for i in range(12)])
        return JobClient(docs)
    first, second = _block(_run(monkeypatch, make())[0][0]), _block(_run(monkeypatch, make())[0][0])
    assert first and first == second
    assert first.count('Words: ') == JOB_SIMILAR_SENTENCES


# --- scale (BRIEF-SS 6) ------------------------------------------------------------

@pytest.mark.parametrize('n', [2000, 20000])
def test_the_rule_costs_little_on_a_large_pool(n, capsys):
    import random
    rnd = random.Random(7)
    letters = 'aeioukgtmnslrdbpz'

    def word():
        return ''.join(rnd.choice(letters) for _ in range(rnd.randint(2, 9)))
    vocab = [word() for _ in range(3000)]
    sentences = [[rnd.choice(vocab) for _ in range(rnd.randint(4, 14))] for _ in range(n)]
    t0 = time.perf_counter()
    feats = [similar.features(s) for s in sentences]
    t1 = time.perf_counter()
    pool = similar.Pool(feats)
    t2 = time.perf_counter()
    queries = [similar.features(s) for s in sentences[:5]]
    taken = similar.pick(pool, queries, skip=frozenset(range(5)))
    t3 = time.perf_counter()
    examples = [{'text': ' '.join(sentences[i]), 'words': [_analysis(w, 'x') for w in sentences[i]]} for i in taken]
    assert len(similar.block(examples, ['Morph Gloss'])) <= JOB_SIMILAR_CHARS and len(taken) == JOB_SIMILAR_SENTENCES
    with capsys.disabled():
        print(f'\nSS timing, {n} pool sentences: features {1000 * (t1 - t0):.0f} ms (once per read document), '
              f'weights {1000 * (t2 - t1):.0f} ms (once per change), a piece of 5 sentences {1000 * (t3 - t2):.0f} ms')


def _without_morphemes(raw):
    """``raw`` (a project or a document) with no morpheme layer."""
    raw['text_layers'][0]['token_layers'] = [tk for tk in raw['text_layers'][0]['token_layers']
                                             if tk['id'] != MORPH_LAYER]
    return raw


def test_a_word_field_job_in_a_project_with_no_morpheme_layer_shows_each_words_surface(monkeypatch):
    client = JobClient({'A': _without_morphemes(document('A', 'Doc A', [{'words': ['gamda', 'zo']}])),
                        'P': _without_morphemes(_unsegmented_people())},
                       project=_without_morphemes(_animacy_project()))
    (asked, _), = _run(monkeypatch, client, fills=(ROLE,))
    assert _block(asked).split('\n')[-2:] == ['Words: ["gamdi", "ka"]', 'Animacy: ["animate", "_"]'], asked


@pytest.mark.parametrize('n', [2000, 20000])
def test_a_word_field_pool_costs_little_on_many_candidates(n, capsys):
    """``n`` candidate sentences, about half holding a person's Animacy: the
    filter and the pool of a stretch that fills only word fields."""
    import random
    rnd = random.Random(7)
    letters = 'aeioukgtmnslrdbpz'

    def word():
        return ''.join(rnd.choice(letters) for _ in range(rnd.randint(2, 9)))
    vocab = [word() for _ in range(3000)]
    sentences = [[rnd.choice(vocab) for _ in range(rnd.randint(4, 14))] for _ in range(n)]
    candidates = [{'feats': similar.features(s),
                   'people_fields': frozenset({'Animacy'}) if rnd.random() < 0.5 else frozenset()}
                  for s in sentences]
    t0 = time.perf_counter()
    held = [x for x in candidates if similar.holds(x, frozenset({'Animacy', 'Role'}))]
    t1 = time.perf_counter()
    pool = similar.Pool([x['feats'] for x in held])
    t2 = time.perf_counter()
    taken = similar.pick(pool, [similar.features(s) for s in sentences[:5]])
    t3 = time.perf_counter()
    assert 0 < len(held) < n and len(taken) == JOB_SIMILAR_SENTENCES
    with capsys.disabled():
        print(f'\nWord field pool timing, {n} candidates ({len(held)} held): filter {1000 * (t1 - t0):.1f} ms, '
              f'weights {1000 * (t2 - t1):.0f} ms (once per change), a piece of 5 sentences {1000 * (t3 - t2):.0f} ms')


# --- what a job keeps (round 2) ----------------------------------------------------

def _kept(monkeypatch, client, fills):
    """The candidates the job's runner kept after its run."""
    job = start(client, id=J, documents=['A'], fills=fills)
    use(monkeypatch, Model(lambda asked, n, kwargs: reply('Done.')))
    r = runner(job)
    run_job(job, r)
    return r.candidates


def _filled_unsegmented():
    """:func:`_people` beside unsegmented sentences people gave a Role, and
    one they gave a word Gloss only."""
    raw = document('P', 'Other', [
        {'words': [('gamdi', [('gam', 'fish'), ('di', 'ERG')], 'human'), ('ka', [('ka', 'eat')], 'human')]},
        {'words': ['gamdo', 'zo']}, {'words': ['gamdu', 'zu']},
        {'words': [{'form': 'gamde', 'who': 'human', 'gloss': ('fish.X', 'human')}, 'ze']}])
    return with_values(raw, [(ROLE, 'P-s2w1', 'agent', 'human'), (ROLE, 'P-s3w2', 'act', 'human')])


def test_a_job_that_segments_keeps_only_the_analysed_sentences(monkeypatch):
    client = JobClient({'A': document('A', 'Doc A', [{'words': ['gamda', 'zo']}]), 'P': _filled_unsegmented()},
                       project=fields_project())
    kept = _kept(monkeypatch, client, ('segmentation', ROLE))
    assert [x['text'] for x in kept] == ['gamdi ka.'] and all(x['analysed'] for x in kept), kept


def test_a_word_field_job_keeps_the_sentences_holding_its_own_fields_only(monkeypatch):
    """The sentence holding only a word Gloss is not kept for a job that
    fills Role: its pool is by layer id."""
    client = JobClient({'A': document('A', 'Doc A', [{'words': ['gamda', 'zo']}]), 'P': _filled_unsegmented()},
                       project=fields_project())
    kept = _kept(monkeypatch, client, (ROLE,))
    assert [x['text'] for x in kept] == ['gamdi ka.', 'gamdo zo.', 'gamdu zu.'], kept
    assert [x['people_fields'] for x in kept] == [frozenset(), frozenset({ROLE}), frozenset({ROLE})]
    assert kept[1]['words'][0]['word_ids'] == {ROLE: 'agent'}


def test_a_decomposed_surface_is_shown_composed(monkeypatch):
    """A word of a project with no morpheme layer, its accent typed as a
    combining mark: its forms are NFC, as morpheme forms are."""
    decomposed = 'game' + chr(0x301)
    people = _without_morphemes(with_values(document('P', 'Other', [{'words': [decomposed, 'ka']}]),
                                            [(ROLE, 'P-s1w1', 'animate', 'human')]))
    client = JobClient({'A': _without_morphemes(document('A', 'Doc A', [{'words': ['gamda', 'zo']}])), 'P': people},
                       project=_without_morphemes(_animacy_project()))
    (asked, _), = _run(monkeypatch, client, fills=(ROLE,))
    assert _block(asked).split('\n')[-2] == 'Words: ["gam' + chr(0xe9) + '", "ka"]', asked
