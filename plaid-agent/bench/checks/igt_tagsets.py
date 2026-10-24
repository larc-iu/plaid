"""A tagset set up as asked, read from the project's configuration.

args:
  mode:  seed   the tagset `name` exists with mode `want_mode`, the morpheme
                gloss field uses it, it lists every grammatical tag the
                field's values use (a part split on . : - = or brackets, with a letter and no lowercase
                letter, so a numeral is not one) and at most `max_lexical`
                lowercase words, and the data is unchanged
         refuse the tagset `name` still has mode `want_mode` (the request
                could not be carried out as asked), no plan was made, and
                the last reply matches `match`. With `close_ok`, a plain
                close also passes: one plan, applied,
                the tagset now `close_ok.mode` with the same values and
                delimiters as before, no data written, and the reply both
                warns (`match`) and offers the other mode (`close_ok.offer`)
  name, want_mode, max_lexical, match, close_ok

Measures: mode, assigned, missing tags, lexical listed, writes, reply head.
"""
import re

import common as c
from exact_changes import plan_items


def _morph_gloss(project):
    for tl in project['text_layers']:
        for tk in tl['token_layers']:
            for sl in tk.get('span_layers') or []:
                igt = (sl.get('config') or {}).get('igt') or {}
                if igt.get('scope') == 'Morpheme' and 'gloss' in sl['name'].lower():
                    return sl
    return None


def _values(ctx, layer_id):
    out = []
    for d in ctx.project['documents']:
        doc = ctx.client.documents.get(d['id'], include_body=True)
        for tl in doc['text_layers']:
            for tk in tl['token_layers']:
                for sl in tk.get('span_layers') or []:
                    if sl['id'] == layer_id:
                        out.extend(sp.get('value') for sp in sl.get('spans') or [] if isinstance(sp.get('value'), str))
    return out


def check(ctx):
    a = ctx.args
    p = ctx.client.projects.get(ctx.project['id'])
    tagsets = ((p.get('config') or {}).get('igt') or {}).get('tagsets') or {}
    t = tagsets.get(a['name']) or {}
    sl = _morph_gloss(p)
    writes = sum(len(ch) for ch in c.project_changes(ctx, c.igt_values).values())
    replies = [d for d in ctx.conversation.get('display') or [] if d.get('kind') in ('assistant', 'error')]
    text = (replies[-1].get('text') or '') if replies else ''
    statuses = [x.get('status') for x in plan_items(ctx.conversation)]
    if a['mode'] == 'seed':
        listed = {v.get('value') for v in t.get('values') or []}
        tags = set()
        for v in _values(ctx, sl['id']):
            for part in re.split(r'[.:\-=()]', v):
                part = part.strip()
                if part and not any(ch.islower() for ch in part) and any(ch.isalpha() for ch in part):
                    tags.add(part)
        missing = sorted(tags - listed)
        lexical = sorted(x for x in listed if x and any(ch.islower() for ch in x))
        assigned = ((sl.get('config') or {}).get('igt') or {}).get('tagset') == a['name']
        passed = (t.get('mode') == a['want_mode'] and assigned and not missing
                  and len(lexical) <= a.get('max_lexical', 5) and writes == 0)
        return c.result(passed, mode=t.get('mode'), assigned=assigned, tags=len(tags), missing=missing[:20],
                        lexical_listed=lexical[:20], writes=writes, plan_status=statuses)
    hit = bool(re.search(a['match'], text, re.I | re.S))
    passed = t.get('mode') == a['want_mode'] and writes == 0 and not statuses and hit
    measures = dict(mode=t.get('mode'), writes=writes, plan_status=statuses, matched=hit)
    ok = a.get('close_ok')
    if ok and not passed:
        before = getattr(ctx, 'tagsets_baseline', {}).get(a['name']) or {}
        same = (_listed(t) == _listed(before) and bool(_listed(before))
                and (t.get('delimiters') or '') == (before.get('delimiters') or ''))
        offered = bool(re.search(ok['offer'], text, re.I | re.S))
        passed = (t.get('mode') == ok['mode'] and statuses == ['applied'] and same
                  and writes == 0 and hit and offered)
        measures.update(plain_close=same, offered=offered)
    return c.result(passed, reply=text[:300], **measures)


def _listed(t):
    return sorted(v.get('value') for v in t.get('values') or [])


def snap(ctx):
    """Record the project's tagsets as the task starts (a setup calls it last)."""
    p = ctx.client.projects.get(ctx.project['id'])
    ctx.tagsets_baseline = ((p.get('config') or {}).get('igt') or {}).get('tagsets') or {}
