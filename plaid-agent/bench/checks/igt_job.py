"""Checks an unattended job's run (tasks whose yaml says `job:` in place of
turns). Reads the documents with the assistant's parser, and judges them by
rules of its own, written here from the SPEC of the jobs round and never
taken from the worker (plaid_agent.igt.job): a bug in the worker's rules
must not pass its own check (REV-J-B S3-8).

Every job task:
- the job ended `done`,
- nothing protected changed: a word that was not blank keeps its analysis
  and its provenance, a translation a person wrote keeps its value,
- every word that changed was blank and is now wholly the job's own work,
  every piece machine-unverified with the job's id in provDetail (or was left
  blank),
- every translation that changed was empty or a machine draft and is now the
  job's own,
- no two entries the job made share a form and gloss, and none repeats an
  entry that was there before.

args:
  mode: stretch | harmonize
  document, sentences: (stretch) the target sentences, every target word of
    which is analysed or left, at least one analysed
  form: (harmonize) SPEC 8 for that form. People analysed it one way (the
    task's setup). Each History entry of the job's harmonize pass is read
    against the document as it was just before it: every word it changed was
    then wholly the job's own unverified work (a word holding anything of a
    person's or another producer's is never harmonize's), and is now the
    job's own and, for the form, the people's analysis, with each word field
    the job had written on it now the value the people's words hold (or
    cleared) and no field added. After the job the
    job's words of the form carry one analysis: harmonize leaves a form the
    job analysed one way as it is, whatever people did.
"""
import json
from datetime import datetime, timedelta, timezone

from plaid_agent.igt.project import load_document, load_project, parse_document

import common as c


# --- the rules, the checker's own ----------------------------------------------------

def _job_piece(md, jid):
    """Machine-unverified and naming the job (SPEC 6.4)."""
    md = md or {}
    return md.get('prov') == 'inferred' and not md.get('provConfirmed') \
        and isinstance(md.get('provDetail'), dict) and md['provDetail'].get('job') == jid


def _real(w):
    return [m for m in w.morphemes if not m.virtual]


def _pieces(w):
    """Everything on a word anyone wrote: stamped morpheme tokens, morpheme
    spans and links, word-scope spans, the word's own link."""
    out = []
    for m in _real(w):
        if (m.metadata or {}).get('prov') is not None:
            out.append(m.metadata)
        out += [sp.metadata for sp in m.fields.values()]
        if m.link is not None:
            out.append(m.link.metadata)
    out += [sp.metadata for sp in w.fields.values()]
    if w.link is not None:
        out.append(w.link.metadata)
    return out


def _blank(w):
    """No analysis and no word value (SPEC 6.1): no morpheme span or link,
    no morpheme but the word's own default one, no word field."""
    ms = _real(w)
    if any(m.fields or m.link is not None for m in ms):
        return False
    if len(ms) > 1 or any(m.morph_type or (m.form not in (None, '') and m.form != w.surface) for m in ms):
        return False
    return not any(sp.value not in (None, '') for sp in w.fields.values())


def _job_own(w, jid):
    pieces = _pieces(w)
    return bool(pieces) and not _blank(w) and all(_job_piece(p, jid) for p in pieces)


def _analysis(w):
    """The analysis as harmonize writes it: morphemes, types, "=", fields."""
    return json.dumps([[m.form, m.morph_type or None, bool(m.equals_before),
                        sorted((n, sp.value) for n, sp in m.fields.items() if sp.value not in (None, ''))]
                       for m in _real(w)], ensure_ascii=False)


def _everything(w):
    return json.dumps([_analysis(w), [[m.link.item_id if m.link else None, m.metadata] for m in _real(w)],
                       sorted((n, sp.value, json.dumps(sp.metadata, sort_keys=True)) for n, sp in w.fields.items()),
                       [json.dumps(sp.metadata, sort_keys=True) for m in _real(w) for sp in m.fields.values()]],
                      ensure_ascii=False, sort_keys=True, default=str)


def _word_values(w):
    return {n: sp.value for n, sp in w.fields.items() if sp.value not in (None, '')}


def _translation(s, project):
    f = project.gloss_field('Sentence')
    sp = s.fields.get(f.name) if f else None
    return (None, None) if sp is None or (sp.value or '') == '' else (sp.value, sp.metadata or {})


def _translation_target(s, project):
    value, md = _translation(s, project)
    return value is None or (md.get('prov') == 'inferred' and not md.get('provConfirmed'))


def _form(surface):
    import unicodedata
    return unicodedata.normalize('NFC', surface or '').casefold()


def _just_before(iso):
    t = datetime.fromisoformat(str(iso).replace('Z', '+00:00')) - timedelta(milliseconds=1)
    return t.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


# --- the check -------------------------------------------------------------------------

def _harmonize(ctx, project, jid, docs, args, problems):
    key = _form(args['form'])
    people = set()
    for doc in docs.values():
        for s in doc.sentences:
            for w in s.words:
                if _form(w.surface) == key and _real(w) and any(not _job_piece(p, jid) and (p or {}).get('prov') is None
                                                                for p in _pieces(w)):
                    people.add(_analysis(w))
    if len(people) != 1:
        problems.append(f'the task wants one analysis by people of {args["form"]}, found {len(people)}')
        return
    (theirs,) = people
    # The word fields that go with the people's analysis: those most of their
    # words of the form hold (the first in order on a tie).
    held = {}
    for doc in docs.values():
        for s in doc.sentences:
            for w in s.words:
                if _form(w.surface) == key and _real(w) and _analysis(w) == theirs \
                        and not any(_job_piece(p, jid) for p in _pieces(w)):
                    k = json.dumps(_word_values(w), sort_keys=True, ensure_ascii=False)
                    held[k] = held.get(k, 0) + 1
    their_words = json.loads(sorted(held.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]) if held else {}
    mine = {}
    for name, doc in docs.items():
        for s in doc.sentences:
            for w in s.words:
                if _form(w.surface) == key and _job_own(w, jid):
                    mine[f'{name} s{s.index}.w{w.index}'] = _analysis(w)
    if not mine:
        problems.append(f'the job analysed no {args["form"]}')
    elif len(set(mine.values())) > 1:
        problems.append(f'the job left {args["form"]} analysed {len(set(mine.values()))} ways')
    for d in ctx.project['documents']:
        after = docs[d['name']]
        units = [e for e in ctx.client.documents.audit(d['id'], kinds=['job']) or []
                 if str(e.get('ref') or '').startswith(f'job:{jid}/') and str(e.get('ref')).endswith('/pass:harmonize')]
        for unit in units:
            raw = ctx.client.documents.get(d['id'], include_body=True, as_of=_just_before(unit['time']),
                                           layers=project.read_layer_ids())
            before = parse_document(raw, project)
            now = {w.id: (s, w) for s in after.sentences for w in s.words}
            for s in before.sentences:
                for w in s.words:
                    hit = now.get(w.id)
                    if hit is None or _everything(w) == _everything(hit[1]):
                        continue
                    where = f'{d["name"]} s{s.index}.w{w.index}'
                    if not _job_own(w, jid):
                        problems.append(f'{where}: harmonize changed a word that held something not the job\'s')
                    elif not _job_own(hit[1], jid):
                        problems.append(f'{where}: harmonize left a word not the job\'s own')
                    elif _form(w.surface) == key and _analysis(hit[1]) != theirs:
                        problems.append(f'{where}: harmonize set {args["form"]} to an analysis people did not make')
                    elif _form(w.surface) == key:
                        # What the job wrote on the word goes with the analysis:
                        # each word field it held is now the people's value, or
                        # cleared, and none was added.
                        was, now_ = _word_values(w), _word_values(hit[1])
                        if set(now_) - set(was) or any(now_.get(n) != their_words.get(n) for n in was):
                            problems.append(f'{where}: harmonize left the job\'s word fields {now_}, '
                                            f'the analysis carries {their_words}')


def check(ctx):
    job = getattr(ctx, 'job', None)
    if not job:
        return c.result(False, why='no job ran')
    jid = job['id']
    project = load_project(ctx.client, ctx.project['id'])
    args = ctx.args or {}
    problems, analysed, left = [], 0, 0
    docs = {}
    for d in ctx.project['documents']:
        before = parse_document(c.baseline(d['id'], getattr(ctx, 'baseline_dir', None)), project)
        after = load_document(ctx.client, project, d['id'])
        docs[d['name']] = after
        now = {s.id: s for s in after.sentences}
        for s in before.sentences:
            t = now.get(s.id)
            if t is None:
                problems.append(f'{d["name"]} s{s.index}: gone')
                continue
            if _translation(s, project) != _translation(t, project):
                value, md = _translation(t, project)
                if not _translation_target(s, project) or value is None or not _job_piece(md, jid):
                    problems.append(f'{d["name"]} s{s.index}: translation changed and is not the job\'s')
            words = {w.id: w for w in t.words}
            for w in s.words:
                x = words.get(w.id)
                if x is None:
                    problems.append(f'{d["name"]} s{s.index}.w{w.index}: gone')
                    continue
                if _everything(w) == _everything(x):
                    continue
                if not _blank(w):
                    problems.append(f'{d["name"]} s{s.index}.w{w.index}: not a target, changed')
                elif not _job_own(x, jid):
                    problems.append(f'{d["name"]} s{s.index}.w{w.index}: changed, not the job\'s own machine work')
    if args.get('mode') == 'stretch':
        doc = docs[args['document']]
        before = parse_document(c.baseline(next(d['id'] for d in ctx.project['documents']
                                                if d['name'] == args['document']), ctx.baseline_dir), project)
        targets = {w.id for s in before.sentences if s.index in args['sentences'] for w in s.words if _blank(w)}
        for s in doc.sentences:
            for w in s.words:
                if w.id in targets:
                    if _job_own(w, jid):
                        analysed += 1
                    elif _blank(w):
                        left += 1
        if not analysed:
            problems.append('no target word was analysed')
    if args.get('mode') == 'harmonize':
        _harmonize(ctx, project, jid, docs, args, problems)
    seen = {}
    for v in project.vocabs:
        if v.get('borrowed'):
            continue
        gloss = project.lexicon_field(v, 'gloss')
        items = ctx.client.vocab_layers.get(v['id'], include_items=True).get('items') or []
        for it in items:
            k = (v['id'], it.get('form'), (it.get('metadata') or {}).get(gloss))
            seen.setdefault(k, []).append(((it.get('metadata') or {}).get('provDetail') or {}).get('job'))
    dupes = [k for k, jobs in seen.items() if len(jobs) > 1 and jid in jobs]
    if dupes:
        problems.append(f'entries the job made repeat a form and gloss: {dupes[:5]}')
    if job.get('state') != 'done':
        problems.append(f'the job ended {job.get("state")}')
    return c.result(not problems, problems=problems[:20], analysed=analysed, left=left,
                    report=(job.get('report') or {}).get('totals'))
