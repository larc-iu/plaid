"""ud_tree, and the surface tokens of the sentences a task names.

A token split into tokens leaves every word, value and head where it was, so
the word-level reader cannot tell it from no change at all: only the tokens
can. This checker passes when ud_tree passes and each named sentence of the
task's document holds exactly the tokens given, by their text.

args: everything ud_tree takes, plus
  tokens: {"s8": ["Les", "compagnies", ...]} the token texts of each sentence
          named, in order (a multi-word token is one entry)
"""
import common as c
import ud_tree


def sentence_tokens(raw, n):
    tl = raw['text_layers'][0]
    text = c._cp(tl['text']['body'])
    sents = c._sorted(c._layer(tl, 'sentence')['tokens'])
    if not 1 <= n <= len(sents):
        return None
    s = sents[n - 1]
    return [text(t['begin'], t['end']) for t in c._sorted(c._layer(tl, 'word')['tokens']) if c._within(t, s)]


def check(ctx):
    got = ud_tree.check(ctx)
    want = ctx.args.get('tokens') or {}
    d = next(d for d in ctx.project['documents'] if d['name'] == ctx.args['document'])
    raw = ctx.client.documents.get(d['id'], include_body=True)
    seen = {s: sentence_tokens(raw, int(s[1:])) for s in want}
    wrong = {s: seen[s] for s in want if seen[s] != want[s]}
    got['measures']['tokens_ok'] = not wrong
    if wrong:
        got['measures']['tokens_seen'] = wrong
    got['pass'] = bool(got['pass']) and not wrong
    return got
