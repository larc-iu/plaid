"""A job's piece analyses its sentences with analyze_sentence (AS,
2026-11-14): every word is analysed on its own word, the links and the
entries new_entries makes are written, each try is one request, and the
report counts what was written. And run4's mistake, a sentence on its first
word, is refused, so nothing of it is written."""

import copy

from fixtures import lexicon_raw
from job_fixtures import JobClient, Model, blank, call, document, reply, runner, start, targets_named, use

from plaid_client import testing
from plaid_agent.core.job import run_job

J = 'JA'


def _lexicon():
    lex = copy.deepcopy(lexicon_raw())
    lex['items'].append({'id': 'vi-ta', 'form': 'ta', 'metadata': {'gloss': 'that'}})
    return lex


def _batches(monkeypatch):
    sent, real = [], testing._Batch.submit

    def submit(self):
        sent.append(sorted({k for k, _ in self.queued}))
        return real(self)
    monkeypatch.setattr(testing._Batch, 'submit', submit)
    return sent


def _run(monkeypatch, line):
    """A job over five blank sentences of two words, ka<n> ta, whose model
    stages ``line(n)`` for every target sentence n in one call."""
    raw = document('d1', 'Story', blank(5))
    client = JobClient({'d1': copy.deepcopy(raw)}, lexicon=_lexicon())
    client.raw = raw
    job = start(client, 'Segment, gloss and link.', id=J)

    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Glossed the piece.')
        return reply(calls=[call(1, 'analyze_sentence', {
            'document': 'Story', 'new_entries': True,
            'sentences': [{'ref': f's{t}', **line(t)} for t in targets_named(asked)]})])
    use(monkeypatch, Model(answer))
    sent = _batches(monkeypatch)
    finished = run_job(job, runner(job))
    return client, job, finished, sent


def test_a_piece_analyses_five_sentences_word_for_word_and_the_report_counts_it(monkeypatch):
    client, job, finished, sent = _run(monkeypatch, lambda t: {'words': [f'ka-{t} go-X{t}', 'ta that']})
    # Every morpheme sits on its own word: ka-<t> on the word ka<t>, ta on ta.
    layers = client.raw['text_layers'][0]
    body = layers['text']['body']
    placed = {}
    for p in client.payloads('tokens.create'):
        placed.setdefault(tuple(p['args'][2:4]), []).append(p['kwargs']['metadata']['form'])
    assert placed == {(t['begin'], t['end']): (['ka', body[t['begin'] + 2:t['end']]] if body[t['begin']] == 'k'
                                               else ['ta'])
                      for t in layers['token_layers'][1]['tokens']}
    assert len(client.payloads('vocab_items.create')) == 6, 'ka ‘go’ once, X1 to X5 once each'
    assert len(client.payloads('vocab_links.create')) == 15, 'every morpheme of every word'
    counts = job.rows['d1']['counts']
    totals = finished['report']['totals']
    assert (counts['words'], counts['links'], counts['entries']) == (10, 15, 6)
    assert counts['changes'] == totals['changes'] == 10 + 6 + 15, (counts, totals)
    assert totals['proposed'] == 0 and not job.rows['d1'].get('skipped')
    # The write is one try, sent as one request.
    assert len(sent) == len(client.landed_keys) == 1 and client.landed_keys[0].endswith('.0')


def test_run4s_mistake_in_a_piece_writes_nothing_on_the_first_word(monkeypatch):
    client, job, finished, sent = _run(monkeypatch, lambda t: {'words': [f'ka-{t}-ta go-X{t}-that']})
    assert sent == [], sent
    assert finished['report']['totals']['changes'] == 0
