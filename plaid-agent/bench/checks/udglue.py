"""Plant a glued token for a ud task's setup: two neighbouring tokens made
one, as a tokenizer that missed a space leaves them, written straight through
the API (the assistant's own tools refuse to make this shape).

`glue(ctx, document, sentence, token, keep_words)` joins token `token` of
sentence `sentence` (both 1-based, counted as surface tokens) with the token
after it. With keep_words the two words stay, as one multi-word token over
the joined text, each with a Form span and all its values and heads: the
multi-word token built by mistake. Without, the second word goes with its
values and heads, and the first covers the joined text alone.
"""
import common as c


def _form_layer(words):
    return next(sl for sl in words.get('span_layers') or []
                if ((sl.get('config') or {}).get('ud') or {}).get('form'))


def glue(ctx, document, sentence, token, keep_words):
    d = next(d for d in ctx.project['documents'] if d['name'] == document)
    raw = ctx.client.documents.get(d['id'], include_body=True)
    tl = raw['text_layers'][0]
    text = c._cp(tl['text']['body'])
    s = c._sorted(c._layer(tl, 'sentence')['tokens'])[sentence - 1]
    toks = [t for t in c._sorted(c._layer(tl, 'word')['tokens']) if c._within(t, s)]
    a, b = toks[token - 1], toks[token]
    words = c._layer(tl, 'syntactic-word')
    under = lambda t: [w for w in words['tokens'] if (w['begin'], w['end']) == (t['begin'], t['end'])]  # noqa: E731
    [wa], [wb] = under(a), under(b)
    begin, end = a['begin'], b['end']
    with ctx.client.batched() as batch:
        if not keep_words:
            batch.tokens.bulk_delete([wb['id']])
        batch.tokens.merge(a['id'], b['id'])
        batch.tokens.update(wa['id'], begin=begin, end=end, precedence=1)
        if keep_words:
            batch.tokens.update(wb['id'], begin=begin, end=end, precedence=2)
            form = _form_layer(words)['id']
            batch.spans.create(form, [wa['id']], text(a['begin'], a['end']))
            batch.spans.create(form, [wb['id']], text(b['begin'], b['end']))
            batch.tokens.patch_metadata(a['id'], [{'op': 'set', 'path': ['form'], 'value': text(begin, end)}])
