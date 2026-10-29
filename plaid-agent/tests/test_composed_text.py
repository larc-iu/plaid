"""The assistant's new document text is written composed (NFC), as the server
stores it, so its sentences are measured on the text stored."""

import contextlib
from types import SimpleNamespace

from plaid_agent.igt import plan as igt_plan


class _NewId:
    def __init__(self):
        self.n = 0

    def __call__(self):
        self.n += 1
        return f'id-{self.n}'

    def once(self, fn, whole=False):
        return fn()


def test_a_new_documents_text_is_composed_and_its_sentences_measured_on_it():
    sent = {'texts': [], 'tokens': []}
    batch = SimpleNamespace(
        texts=SimpleNamespace(create=lambda layer, doc, text, id=None, tokenize_layer=None:
                              sent['texts'].append((text, tokenize_layer))),
        tokens=SimpleNamespace(bulk_create=lambda ops: sent['tokens'].append(ops)),
    )
    # the text and its sentences go in one batch
    client = SimpleNamespace(batched=lambda: contextlib.nullcontext(batch))
    project = SimpleNamespace(text_layer_id='tl', sentence_layer_id='sl', word_layer_id='wl',
                              tokenize_new_text=True, ignored_cfg=None)
    igt_plan._seed_text(client, project, 'doc', 'pʰa\u0301 bo\u0301\nca\u0301', _NewId())
    body, layer = sent['texts'][0]
    assert body == 'pʰá bó\ncá'
    # the words are the server's, on the text stored
    assert layer == 'wl'
    [sentences] = sent['tokens']
    assert [body[t['begin']:t['end']] for t in sentences] == ['pʰá bó\n', 'cá']


def test_an_edit_is_moved_onto_the_body_the_server_stored():
    # "ka", its tone mark as a word of its own, "ma": the server kept the mark
    # apart from the a, so a position after it is where it was
    text, at = igt_plan._composed_as('ka\u0301 ma tres', 'ka\u0301 ma tres')
    assert text == 'ka\u0301 ma tres'
    assert (at(7), at(11)) == (7, 11)
    # a mark the server gave the token before it composes with its letter
    text, at = igt_plan._composed_as('ka\u0301 ma\u0301', 'ka\u0301 m\u00e1')
    assert text == 'ka\u0301 m\u00e1' and at(6) == 6 and at(7) == 6
    # a line typed after it: its start is after the composed letter
    text, at = igt_plan._composed_as('Ali-di\u0301\ngam', 'Ali-d\u00ed\ngam')
    assert text == 'Ali-d\u00ed\ngam' and (at(6), at(8)) == (6, 7)
    # Hangul jamo the server joined, and two tone marks kept apart in one word
    assert igt_plan._composed_as('\u1100\u1161 x', '\uac00 x')[0] == '\uac00 x'
    assert igt_plan._composed_as('a\u0301ba\u0301', 'a\u0301b\u00e1')[0] == 'a\u0301b\u00e1'
    # a body the edit cannot have made: the text changed meanwhile
    assert igt_plan._composed_as('ka ma', 'ka mo') is None
    assert igt_plan._composed_as('ka ma', 'ka  ma') is None


# Bodies core stored after an edit (REV-BH7-TEXT F1, read off core's own
# compose), with core's place for every position. The first is stored as sent,
# kept decomposed by its token edges. The others need four or more cuts in one
# run of marks, past what a search over cut combinations reached.
CORE_STORED = [
    ('ِٕٕٔٔأّ',
     'ِٕٕٔٔأّ',
     [0, 1, 2, 3, 4, 5, 6, 7, 8]),
    ('ּבְָָּּׁׁׁׁ',
     'ּבְָָּּׁׁׁׁ',
     list(range(12))),
    ('ِّٕٕأَّٓلَٔ',
     'ِّٕٕأَّٓلَٔ',
     [0, 1, 2, 3, 4, 5, 6, 9, 9, 9, 10, 11, 12]),
    ('=≠kḳ̣̣́́́́e',
     '=≠kḳ̣̣́́́́e',
     [0, 1, 2, 3, 4, 5, 6, 7, 10, 10, 10, 11, 12, 13]),
    ('\nἀᾁ̔̔ἀ \nͅ῎ῃ᾿',
     '\nἀᾁ̔̔ἀ \nͅ῎ῃ᾿',
     [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 13, 14, 14, 15]),
    ('\nְָשָּשָׁשְָָּּּׁׁ',
     '\nְָשָּשָׁשְָָּּּׁׁ',
     [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 18]),
]


def test_a_body_stored_with_many_cuts_in_one_run_is_core_s():
    for sent, stored, core_at in CORE_STORED:
        got = igt_plan._composed_as(sent, stored)
        assert got is not None, ascii(sent)
        text, at = got
        assert text == stored
        assert [at(p) for p in range(len(sent) + 1)] == core_at, ascii(sent)


def _thai_run(n, seed):
    # a run with no space: consonants, each with marks in the order NFC keeps,
    # and one character at the end whose two marks a token edge keeps apart in
    # an order NFC would swap (U+0E48 before U+0E38)
    import random
    rng = random.Random(seed)
    run = ''
    while len(run) < n:
        run += rng.choice('กขคง') + rng.choice(['', 'ิ', 'ุ', 'ุ่', 'ั้'])
    return run + 'กุ่'


def test_a_long_run_with_no_space_is_read_in_time_linear_in_its_length():
    from plaid_client.testing import timed, within_factor_of
    small, big = _thai_run(300, 1), _thai_run(3000, 2)
    for run in (small, big):
        text, at = igt_plan._composed_as(run, run)
        assert text == run
    # the body sent composes an a and its mark, so the identity shortcut is
    # not what is timed, and the stored run keeps its last character's marks
    # apart, which takes a cut there
    def case(run):
        return lambda: igt_plan._composed_as('a\u0301' + run, '\u00e1' + run)

    def check(run):
        got = case(run)()
        assert got is not None and got[0] == '\u00e1' + run

    check(small)
    check(big)
    _, small_ms = timed(case(small), runs=3)
    _, big_ms = timed(case(big), runs=3)
    within_factor_of(30, small_ms, big_ms, floor_ms=2, label='3,000 against 300 code points')
