"""A piece of a job planned in sentences that segments is handed the
sentences of the project most like its own, as people analysed them
(BRIEF-SS, igt/similar.py): after the evidence block, the most alike last,
within JOB_SIMILAR_CHARS, never one of the piece's own sentences, never one
the job wrote in, and none for a job that does not segment."""

import time

import pytest

from fixtures import TRANS
from job_fixtures import JobClient, Model, document, reply, runner, start, use

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


def test_the_cut_at_the_budget_drops_the_least_similar():
    examples = [{'text': f'sentence {i}.', 'words': [f'w{i} g{i}']} for i in range(3)]
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
    examples = [{'text': ' '.join(sentences[i]), 'words': [f'{w} x' for w in sentences[i]]} for i in taken]
    assert len(similar.block(examples)) <= JOB_SIMILAR_CHARS and len(taken) == JOB_SIMILAR_SENTENCES
    with capsys.disabled():
        print(f'\nSS timing, {n} pool sentences: features {1000 * (t1 - t0):.0f} ms (once per read document), '
              f'weights {1000 * (t2 - t1):.0f} ms (once per change), a piece of 5 sentences {1000 * (t3 - t2):.0f} ms')
