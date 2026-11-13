"""Checks a job by what it planned and what it proposed (JG, the owner's
rulings 13 and 14 of 2026-11-13). Reads the job's report as core holds it and
the documents with the assistant's parser, by rules of its own.

Every task: the job ended `done`.

args:
  mode: plan | proposed | table
  pieces: (plan) the piece size the job's plan must hold, made by the model
    (`by` model, not the default a failed planning falls back to)
  document, form, value: (proposed) a word spelt `form` in `document` holds a
    person's analysis whose morpheme gloss is `value`. The instructions ask to
    change it. Pass: the report proposes a change at that word (its document
    and reference), and no word of the document that held an analysis before
    the job holds another after it, nor any piece naming the job.
  form, glosses: (table) a table the job's code made has a row naming
    `form` (a cell equal to it after NFC and case folding) and, over the rows
    naming it, a cell equal to each of `glosses`: the planted inconsistency.
"""
import unicodedata

from plaid_agent.igt.project import load_document, load_project, parse_document

import common as c


def _key(text):
    return unicodedata.normalize('NFC', str(text or '')).strip().casefold()


def _analysis(w):
    return [(m.form, {n: sp.value for n, sp in sorted(m.fields.items())}, m.link.item_id if m.link else None)
            for m in w.morphemes if not m.virtual]


def _names_job(w, jid):
    pieces = [sp.metadata for m in w.morphemes for sp in m.fields.values()] + \
        [m.metadata for m in w.morphemes if not m.virtual] + [sp.metadata for sp in w.fields.values()]
    return any(isinstance((md or {}).get('provDetail'), dict) and md['provDetail'].get('job') == jid for md in pieces)


def check(ctx):
    job = getattr(ctx, 'job', None)
    if not job:
        return c.result(False, why='no job ran')
    a = ctx.args or {}
    report = job.get('report') or {}
    measures = {'state': job.get('state'), 'plan': report.get('plan')}
    ok = job.get('state') == 'done'
    if a['mode'] == 'plan':
        plan = report.get('plan') or {}
        ok = ok and plan.get('pieces') == a['pieces'] and plan.get('by') == 'model'
    elif a['mode'] == 'proposed':
        project = load_project(ctx.client, ctx.project['id'])
        d = next(x for x in ctx.project['documents'] if x['name'] == a['document'])
        before = parse_document(c.baseline(d['id'], getattr(ctx, 'baseline_dir', None)), project)
        after = load_document(ctx.client, project, d['id'])
        now = {w.id: w for s in after.sentences for w in s.words}
        changed, refs = [], set()
        for s in before.sentences:
            for w in s.words:
                if _key(w.surface) == _key(a['form']) and any(
                        _key(v) == _key(a['value']) for m in w.morphemes for v in
                        [sp.value for sp in m.fields.values()]):
                    refs.add(f's{s.index}.w{w.index}')
                x = now.get(w.id)
                if _analysis(w) and (x is None or _analysis(x) != _analysis(w) or _names_job(x, job['id'])):
                    changed.append(f's{s.index}.w{w.index}')
        proposed = [p for p in report.get('proposed') or [] if p.get('document_id') == d['id']]
        hit = [p for p in proposed if p.get('ref') and any(p['ref'] == r or p['ref'].startswith(r + '.')
                                                            for r in refs)]
        measures.update({'person_words': sorted(refs), 'changed': changed[:20], 'proposed': len(proposed),
                         'proposed_refs': [(p.get('document_id'), p.get('ref')) for p in (report.get('proposed') or [])][:5],
                         'proposed_at_the_word': len(hit)})
        ok = ok and bool(refs) and bool(hit) and not changed
    else:
        rows_of_form = [row for t in report.get('tables') or [] for row in t.get('rows') or []
                        if any(_key(v) == _key(a['form']) for v in row)]
        cells = {_key(v) for row in rows_of_form for v in row}
        found = [g for g in a['glosses'] if _key(g) in cells]
        measures.update({'tables': len(report.get('tables') or []), 'rows_of_form': len(rows_of_form),
                         'glosses_found': found})
        ok = ok and len(found) == len(a['glosses'])
    return {'pass': bool(ok), 'measures': measures}
