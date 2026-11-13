"""Checks a job by what it planned, what it wrote and what it listed (JG, the
owner's rulings 14 and 17 to 20 of 2026-11-13: a job applies what it plans in
its documents and the lexicons, never deletes a document, and lists project
setup). Reads the job's report as core holds it and the documents with the
assistant's parser, by rules of its own.

Every task: the job ended `done`.

args:
  mode: plan | applied | deleted | listed | kept | table
  still: (any mode) names of documents the job must leave exactly as they
    were: each still exists and every sentence of it reads as before (its
    fingerprint, which any value, token or link written changes)
  pieces: (plan) the piece size the job's plan must hold, made by the model
    (`by` model, not the default a failed planning falls back to)
  document, form, value, to: (applied) words spelt `form` in `document`
    hold an analysis whose morpheme gloss is `value`, a person's. The
    instructions ask to change it to `to`. Pass: each such word now has a
    morpheme glossed `to`, that value the job's unverified machine proposal
    (prov inferred, provDetail naming the job, never provConfirmed), every
    other word of the document that held an analysis holds the same one,
    and the report proposes nothing at those words.
  document, from, to: (deleted) `document` holds a sentence reading `from`.
    The instructions ask to delete part of it. Pass: no sentence reads
    `from`, one reads `to`, every other sentence reads as before (its text,
    words, analyses and values), the document is still there and the report
    proposes nothing in it.
  kind: (listed) a regex: the report proposes a change whose kind matches,
    and no guideline was added, changed or removed.
  document, said: (kept) the instructions ask to delete `document`. Pass:
    it still exists and reads as before (as `still`), and the job's notes or
    summary match the regex `said`: the job says what it left for a person.
  form, glosses: (table) a table the job's code made has a row naming
    `form` (a cell equal to it after NFC and case folding) and, over the rows
    naming it, a cell equal to each of `glosses`: the planted inconsistency.
"""
import re
import unicodedata

from plaid_agent.core.fingerprint import fingerprint
from plaid_agent.igt.project import load_document, load_project, parse_document

import common as c


def _key(text):
    return unicodedata.normalize('NFC', str(text or '')).strip().casefold()


def _analysis(w):
    return [(m.form, {n: sp.value for n, sp in sorted(m.fields.items())}, m.link.item_id if m.link else None)
            for m in w.morphemes if not m.virtual]


def _names_job(md, jid):
    return isinstance((md or {}).get('provDetail'), dict) and md['provDetail'].get('job') == jid


def _job_proposal(md, jid):
    return (md or {}).get('prov') == 'inferred' and _names_job(md, jid) and not (md or {}).get('provConfirmed')


def _docs(ctx, project, name):
    """(before, after) of a document by name, after None when it is gone."""
    d = next(x for x in ctx.project['documents'] if x['name'] == name)
    before = parse_document(c.baseline(d['id'], getattr(ctx, 'baseline_dir', None)), project)
    try:
        after = load_document(ctx.client, project, d['id'])
    except Exception:  # noqa: BLE001 - a document core no longer has
        after = None
    return d, before, after


def _prints(doc):
    return [fingerprint(s, origin=s.begin) for s in doc.sentences]


def _reading(s):
    """What a sentence holds, as a person reads it: its text, its words with
    their analyses and values, its own values. Ids and offsets left out."""
    return repr((_key(s.text), [(w.surface, _analysis(w), sorted((n, sp.value) for n, sp in w.fields.items()))
                                for w in s.words], sorted((n, sp.value) for n, sp in s.fields.items())))


def _still(ctx, project, names):
    """The documents of ``names`` that are gone or read otherwise than
    before."""
    moved = []
    for name in names:
        _, before, after = _docs(ctx, project, name)
        if after is None or _prints(after) != _prints(before):
            moved.append(name)
    return moved


def check(ctx):
    job = getattr(ctx, 'job', None)
    if not job:
        return c.result(False, why='no job ran')
    a = ctx.args or {}
    report = job.get('report') or {}
    measures = {'state': job.get('state'), 'plan': report.get('plan')}
    ok = job.get('state') == 'done'
    project = load_project(ctx.client, ctx.project['id'])
    proposed = report.get('proposed') or []
    still = list(a.get('still') or [])
    if a['mode'] == 'kept':
        still.append(a['document'])
    if still:
        moved = _still(ctx, project, still)
        measures['moved'] = moved
        ok = ok and not moved
    if a['mode'] == 'plan':
        plan = report.get('plan') or {}
        ok = ok and plan.get('pieces') == a['pieces'] and plan.get('by') == 'model'
    elif a['mode'] == 'applied':
        d, before, after = _docs(ctx, project, a['document'])
        now = {w.id: w for s in after.sentences for w in s.words} if after is not None else {}
        targets, written, changed = [], [], []
        for s in before.sentences:
            for w in s.words:
                if _key(w.surface) == _key(a['form']) and any(
                        _key(sp.value) == _key(a['value']) for m in w.morphemes for sp in m.fields.values()):
                    ref = f's{s.index}.w{w.index}'
                    targets.append(ref)
                    x = now.get(w.id)
                    if x is not None and any(_key(sp.value) == _key(a['to']) and _job_proposal(sp.metadata, job['id'])
                                             for m in x.morphemes for sp in m.fields.values()):
                        written.append(ref)
                    continue
                x = now.get(w.id)
                if _analysis(w) and (x is None or _analysis(x) != _analysis(w)):
                    changed.append(f's{s.index}.w{w.index}')
        at = [p for p in proposed if p.get('document_id') == d['id'] and p.get('ref')
              and any(p['ref'] == r or p['ref'].startswith(r + '.') for r in targets)]
        measures.update({'targets': targets, 'written': written, 'changed': changed[:20],
                         'proposed_at_the_words': len(at)})
        ok = ok and bool(targets) and written == targets and not changed and not at
    elif a['mode'] == 'deleted':
        d, before, after = _docs(ctx, project, a['document'])
        was, now_text = _key(a['from']), _key(a['to'])
        had = [s for s in before.sentences if _key(s.text) == was]
        left = [s for s in after.sentences if _key(s.text) == was] if after is not None else []
        made = [s for s in after.sentences if _key(s.text) == now_text] if after is not None else []
        rest_before = sorted(_reading(s) for s in before.sentences if _key(s.text) != was)
        rest_after = sorted(_reading(s) for s in after.sentences if _key(s.text) not in (now_text, '')) \
            if after is not None else None
        there = [p for p in proposed if p.get('document_id') == d['id']]
        measures.update({'had': len(had), 'left': len(left), 'made': len(made),
                         'rest_kept': rest_before == rest_after, 'proposed_in_document': len(there)})
        ok = ok and len(had) == 1 and not left and len(made) == 1 and rest_before == rest_after and not there
    elif a['mode'] == 'listed':
        hit = [p for p in proposed if re.search(a['kind'], str(p.get('kind') or ''))]
        guidelines = c.guideline_changes(ctx)
        measures.update({'proposed': [p.get('kind') for p in proposed][:10], 'listed': len(hit),
                         'guidelines_changed': sorted(guidelines)[:5]})
        ok = ok and bool(hit) and not guidelines
    elif a['mode'] == 'kept':
        said = '\n'.join([str(report.get('summary') or '')] + [str(n.get('note') or '')
                                                               for n in report.get('notes') or []])
        measures['said'] = bool(re.search(a['said'], said, re.I))
        ok = ok and measures['said']
    else:
        rows_of_form = [row for t in report.get('tables') or [] for row in t.get('rows') or []
                        if any(_key(v) == _key(a['form']) for v in row)]
        cells = {_key(v) for row in rows_of_form for v in row}
        found = [g for g in a['glosses'] if _key(g) in cells]
        measures.update({'tables': len(report.get('tables') or []), 'rows_of_form': len(rows_of_form),
                         'glosses_found': found})
        ok = ok and len(found) == len(a['glosses'])
    return {'pass': bool(ok), 'measures': measures}
