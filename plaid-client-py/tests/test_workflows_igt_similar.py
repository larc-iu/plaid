"""The rule examples are picked by (plaid_client.workflows.igt.similar): the
one an assistant job and the LLM glossing service share."""

from plaid_client.workflows.igt.similar import Pool, features, pick


def _pool(*sentences):
    return Pool([features(s.split()) for s in sentences])


def test_features_are_the_words_and_their_character_3_and_4_grams():
    assert features(['ab', '']) == frozenset({'ab', '^ab', 'ab$', '^ab$'})


def test_a_pool_sentence_sharing_a_stem_with_an_unseen_form_ranks_over_an_unrelated_one():
    pool = _pool('lili mumu', 'gamdi ka', 'zozo tete')
    assert pool.ranked(features(['gamda']), 1) == [1]


def test_a_shared_stem_outweighs_function_words_every_sentence_has():
    pool = _pool('gamdi na', 'lili na ma', 'zozo na ma', 'tete na ma')
    assert pool.ranked(features(['gamda', 'na', 'ma']), 1) == [0]


def test_ties_go_by_pool_order_and_round_robin_takes_each_sentences_nearest_first():
    pool = _pool('ka', 'ka', 'zo', 'zo', 'ta')
    # Two queries: each one's nearest, then each one's second.
    assert pick(pool, [features(['ka']), features(['zo'])], k=4) == [0, 2, 1, 3]
    assert pick(pool, [features(['ka'])], k=2, skip=frozenset({0})) == [1, 2]


def test_the_same_pool_gives_the_same_list_twice():
    sentences = [f'ka{i} zo{i % 3} ta' for i in range(30)]
    q = [features(['ka1', 'zo2'])]
    assert pick(_pool(*sentences), q, k=8) == pick(_pool(*sentences), q, k=8)
    assert len(pick(_pool(*sentences), q, k=8)) == 8
