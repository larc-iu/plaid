"""The assistant's new document text is written composed (NFC), as the server
stores it, so its sentences are measured on the text stored."""

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
    client = SimpleNamespace(
        texts=SimpleNamespace(create=lambda layer, doc, text, id=None, tokenize_layer=None:
                              sent['texts'].append((text, tokenize_layer))),
        tokens=SimpleNamespace(bulk_create=lambda ops: sent['tokens'].append(ops)),
    )
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
