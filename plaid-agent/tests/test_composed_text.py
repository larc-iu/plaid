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
