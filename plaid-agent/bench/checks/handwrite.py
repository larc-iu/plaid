"""Writes by hand, for validating a checker (validate.py): the result a task
asks for, or a wrong one, made directly through the API rather than by an
assistant.

`stamp` is what an approved plan writes on what it creates or rewrites
(plaid-agent: prov inferred, confirmed, provSource service:<id>), so a
right result made by hand is indistinguishable, to a checker, from an
applied plan.
"""
import common as c

SERVICE = 'service:{app}:assist:openai-glm-5.2'


def stamp(app):
    return {'prov': 'inferred', 'provConfirmed': True, 'provSource': SERVICE.format(app=app)}


def doc_of(ctx, name):
    return next(d for d in ctx.project['documents'] if d['name'] == name)


def set_span(ctx, document, address, value, verified=True, reader=None):
    """Set the value of the span at `address` (igt or ud addressing), stamped
    as an approved plan would stamp it unless verified=False."""
    reader = reader or ctx.app
    d = doc_of(ctx, document)
    raw = ctx.client.documents.get(d['id'], include_body=True)
    spans = (c.igt_spans if reader == 'igt' else c.ud_spans)(raw)
    sp = spans[address]
    ctx.user.spans.update(sp['id'], value)
    meta = dict(sp.get('metadata') or {})
    for k in c.PROV_KEYS:
        meta.pop(k, None)
    if verified:
        meta.update(stamp(ctx.app))
    ctx.user.spans.set_metadata(sp['id'], meta)
    return sp['id']


def set_umr_attr(ctx, document, var, rel, value, verified=True):
    """Change one attribute of a UMR node in place (the concept span's
    metadata), as the assistant's set_attribute does."""
    d = doc_of(ctx, document)
    raw = ctx.client.documents.get(d['id'], include_body=True)
    for tk in raw['text_layers'][0]['token_layers']:
        for sl in tk.get('span_layers') or []:
            if not ((sl.get('config') or {}).get('umr') or {}).get('concepts'):
                continue
            for sp in sl.get('spans') or []:
                meta = dict(sp.get('metadata') or {})
                umr = dict(meta.get('umr') or {})
                if umr.get('var') != var:
                    continue
                umr['attrs'] = [dict(a, value=value) if a.get('rel') == rel else a for a in umr.get('attrs') or []]
                meta['umr'] = umr
                for k in c.PROV_KEYS:
                    meta.pop(k, None)
                if verified:
                    meta.update(stamp(ctx.app))
                ctx.user.spans.set_metadata(sp['id'], meta)
                return sp['id']
    raise KeyError(var)


def applied_plan(rows=1):
    """A conversation as the record holds it after one applied plan."""
    return {'messages': [], 'display': [
        {'kind': 'user', 'text': '(validation)'},
        {'kind': 'assistant', 'text': '(validation)', 'status': 'applied',
         'plan': {'id': 'validation', 'proposed': [['validation']] * rows}},
    ]}


def no_plan():
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': '(validation)', 'status': None, 'plan': None}]}


def add_guideline(ctx, title='Glossing convention', body='A convention nobody asked to record.'):
    """An unasked project guideline written as the task's user, the extra an
    assistant may stage on its own (a wrong result for validation)."""
    ctx.user.guidelines.create(ctx.project['id'], title, body=body)
