"""The assistant's new document text is written composed (NFC), as the server
stores it, so its sentences and words are measured on the text stored."""

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


def test_a_new_documents_text_is_composed_and_its_tokens_measured_on_it():
    sent = {'texts': [], 'tokens': []}
    batch = SimpleNamespace(tokens=SimpleNamespace(bulk_create=lambda ops: sent['tokens'].append(ops)))
    client = SimpleNamespace(
        texts=SimpleNamespace(create=lambda layer, doc, text, id=None: sent['texts'].append(text)),
        batched=lambda: contextlib.nullcontext(batch),
    )
    project = SimpleNamespace(text_layer_id='tl', sentence_layer_id='sl', word_layer_id='wl',
                              tokenize_new_text=True, ignored_cfg=None)
    igt_plan._seed_text(client, project, 'doc', 'pʰa\u0301 bo\u0301\nca\u0301', _NewId())
    body = sent['texts'][0]
    assert body == 'pʰá bó\ncá'
    sentences, words = sent['tokens'][0], sent['tokens'][1]
    assert [body[t['begin']:t['end']] for t in sentences] == ['pʰá bó\n', 'cá']
    assert [body[t['begin']:t['end']] for t in words] == ['pʰá', 'bó', 'cá']


def test_an_edit_composes_the_body_as_the_server_does_with_its_token_edges():
    from plaid_client import compose_text
    # "ka", its tone mark as a word of its own, "ma": the server keeps the
    # mark apart from the a, so a word measured after it stays on its letters
    body = 'ka\u0301 ma'
    tokens = [{'begin': 0, 'end': 2}, {'begin': 2, 'end': 3}, {'begin': 4, 'end': 6}]
    gaps = [{'start': 6, 'end': 6, 'value': ' tres'}]
    text, at = compose_text(body + ' tres', igt_plan._edges_after_gaps(tokens, gaps))
    assert text == 'ka\u0301 ma tres'
    assert (at(7), at(11)) == (7, 11)
    # a mark typed after a letter where a token ends goes to that token, and
    # composes with the letter
    typed = [{'start': 6, 'end': 6, 'value': '\u0301'}]
    text, _ = compose_text('ka\u0301 ma\u0301', igt_plan._edges_after_gaps(tokens, typed))
    assert text == 'ka\u0301 m\u00e1'
    # the space between "ka" and its mark deleted: both words keep their letters
    spaced = [{'begin': 0, 'end': 2}, {'begin': 3, 'end': 4}]
    gone = [{'start': 2, 'end': 3, 'value': ''}]
    text, at = compose_text('ka\u0301', igt_plan._edges_after_gaps(spaced, gone))
    assert text == 'ka\u0301'
