"""Fixtures for the multi-word expression, review, comment, history, and
restore tools: variants of the fixture document, and this app's fake client
with the comments, audit window and restore dry run the newer tools call."""

from core.fake_client import ExtFakeClient
from fixtures import FakeClient, document_raw, lexicon_raw

MWE_LINK = 'l-mwe'
PHRASE_ITEM = 'vi-phrase'


def mwe_document_raw():
    """The fixture document plus a multi-word expression "gam akuna" over
    s1.w2 + s1.w3 (w2 and w3 have no link of their own)."""
    raw = document_raw()
    layers = raw['text_layers'][0]['token_layers']
    layers[1]['vocabs'][0]['vocab_links'].append(
        {'id': MWE_LINK, 'vocab_item': {'id': PHRASE_ITEM, 'form': 'gam akuna'}, 'tokens': ['w-2', 'w-3']})
    return raw


def mwe_lexicon_raw():
    lex = lexicon_raw()
    lex['items'].append({'id': PHRASE_ITEM, 'form': 'gam akuna', 'metadata': {'gloss': 'see a fish', 'morphType': 'phrase'}})
    return lex


def mwe_client(machine_mwe: bool = False):
    raw = mwe_document_raw()
    if machine_mwe:
        raw['text_layers'][0]['token_layers'][1]['vocabs'][0]['vocab_links'][1]['metadata'] = \
            {'prov': 'inferred', 'provSource': 'service:mwe'}
    return ExtClient(documents={'d1': raw}, lexicon=mwe_lexicon_raw())


ANN = 'ann@x.com'
BOB = 'bob@x.com'


def contributed_document_raw():
    """The fixture document with work awaiting review: w1's Gloss contributed
    by ann, w1's link contributed by bob, m-1b's gloss machine-made and
    unconfirmed, m-1a's gloss contributed by ann but already verified."""
    raw = document_raw()
    layers = raw['text_layers'][0]['token_layers']
    ann = {'prov': 'contributed', 'provSource': f'user:{ANN}'}
    bob = {'prov': 'contributed', 'provSource': f'user:{BOB}'}
    machine = {'prov': 'inferred', 'provSource': 'service:x'}
    layers[1]['span_layers'][0]['spans'][0]['metadata'] = dict(ann)                       # sp-g1 (Gloss on w-1)
    layers[1]['vocabs'][0]['vocab_links'][0]['metadata'] = dict(bob)                      # l-1 (w-1 link)
    layers[2]['span_layers'][0]['spans'][0]['metadata'] = {**ann, 'provConfirmed': True}  # sp-m1a verified
    layers[2]['span_layers'][0]['spans'][1]['metadata'] = dict(machine)                   # sp-m1b
    return raw


class ExtClient(ExtFakeClient, FakeClient):
    """This app's fake client, with the comments resource, the audit window
    and the restore dry run the newer tools call."""
