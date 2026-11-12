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
  blank), unless it holds a person's own work alone (a person's edit during
  the job, no write of the job's),
- every translation that changed was empty or a machine draft and is now the
  job's own,
- no two entries the job made share a form and gloss, and none repeats an
  entry that was there before.

args:
  mode: stretch | harmonize
  document, sentences: (stretch) the target sentences, every target word of
    which is analysed or left, at least one analysed
  form: (harmonize) SPEC 8 for that form, judged by people's analyses as
    the project was when harmonize began (just before its first History
    entry, REV-J-B2 S2-1). People analysed it one way then (the task's
    setup): each History entry of the job's harmonize pass is read against
    the document as it was just before it, and every word it changed was
    then wholly the job's own unverified work (a word holding anything of a
    person's or another producer's is never harmonize's), exactly as the
    job's own glossing left it (read just after that History entry: a word a
    person changed or deleted a piece of since is never harmonize's), with
    no comment on it or a piece of it and in no multi-word expression
    (REV-J-B2 S3-1), and is now the job's own and, for the form, the
    people's analysis, with each word field the job had written on it now
    the value the people's words hold (or cleared) and no field added. After
    the job the job's words of the form that harmonize may rewrite carry one
    analysis: harmonize leaves a form the job analysed one way as it is,
    whatever people did. People who analysed it two or more ways by then:
    harmonize changes no word of the form.
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

def _persons(md):
    """A piece a person made or confirmed: what makes a word people's
    analysis (SPEC 3.4, protected)."""
    md = md or {}
    return not md.get('prov') or bool(md.get('provConfirmed'))


def _as_of(ctx, project, did, iso):
    raw = ctx.client.documents.get(did, include_body=True, as_of=iso, layers=project.read_layer_ids())
    return parse_document(raw, project)


def _ids(w):
    """The ids a comment on a word or on a piece of it is anchored to."""
    out = {w.id} | {sp.id for sp in w.fields.values()} | ({w.link.id} if w.link is not None else set())
    for m in _real(w):
        out |= {m.id} | {sp.id for sp in m.fields.values()} | ({m.link.id} if m.link is not None else set())
    return out


def _job_units(ctx, did, jid):
    """The document's History entries oldest first, each with the job's pass
    it belongs to (``gloss``, ``harmonize``) or None."""
    units = sorted(ctx.client.documents.audit(did) or [], key=lambda e: e.get('time') or '')
    out = []
    for e in units:
        ref = str(e.get('ref') or '')
        out.append((e, ref.rsplit('/pass:', 1)[1] if ref.startswith(f'job:{jid}/') and '/pass:' in ref else None))
    return out


def _people(docs, key, jid):
    """form ``key``'s analyses by people in ``docs``: analysis -> the word
    field values of each of their words."""
    out = {}
    for doc in docs:
        for s in doc.sentences:
            for w in s.words:
                if _form(w.surface) == key and _real(w) and any(_persons(p) and not _job_piece(p, jid)
                                                                for p in _pieces(w)):
                    out.setdefault(_analysis(w), []).append(json.dumps(_word_values(w), sort_keys=True,
                                                                       ensure_ascii=False))
    return out


def _harmonize(ctx, project, jid, docs, args, problems):
    key = _form(args['form'])
    ids = {d['name']: d['id'] for d in ctx.project['documents']}
    units = {name: _job_units(ctx, did, jid) for name, did in ids.items()}
    begun = min((e['time'] for us in units.values() for e, kind in us if kind == 'harmonize'), default=None)
    # People's analyses as the project was when harmonize began, or now
    # when it never wrote (REV-J-B2 S2-1).
    then = [_as_of(ctx, project, ids[name], _just_before(begun)) for name in ids] if begun else list(docs.values())
    people = _people(then, key, jid)
    if not people:
        problems.append(f'the task wants an analysis by people of {args["form"]}, found none')
        return
    theirs = next(iter(people)) if len(people) == 1 else None
    held = {}
    for v in people.get(theirs, []):
        held[v] = held.get(v, 0) + 1
    # The word fields that go with the people's analysis: those most of their
    # words of the form hold (the first in order on a tie).
    their_words = json.loads(sorted(held.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]) if held else {}
    # What harmonize may rewrite (REV-J-B2 S3-1): a word as the job's own
    # glossing left it, read just after the job's History entry that wrote
    # it, with no comment on it and in no multi-word expression.
    written, comments = {}, set()
    for name, did in ids.items():
        us = units[name]
        for i, (e, kind) in enumerate(us):
            if kind != 'gloss':
                continue
            before = _as_of(ctx, project, did, _just_before(e['time']))
            after = _as_of(ctx, project, did, _just_before(us[i + 1][0]['time'])) if i + 1 < len(us) else docs[name]
            was = {w.id: _everything(w) for s in before.sentences for w in s.words}
            for s in after.sentences:
                for w in s.words:
                    if was.get(w.id) != _everything(w):
                        written[w.id] = _everything(w)
        comments |= {c_.get('entity_id') for c_ in ctx.client.comments.list(ctx.project['id'], document_id=did) or []}

    def why_not(w):
        if not _job_own(w, jid):
            return 'held something not the job\'s'
        if written.get(w.id) != _everything(w):
            return 'was changed after the job\'s glossing wrote it'
        if _ids(w) & comments:
            return 'has a comment'
        if w.mwes:
            return 'is in a multi-word expression'
        return None
    rewritable = {}
    for name, did in ids.items():
        harmonized = [e for e, kind in units[name] if kind == 'harmonize']
        before = _as_of(ctx, project, did, _just_before(harmonized[0]['time'])) if harmonized else docs[name]
        for s in before.sentences:
            for w in s.words:
                if _form(w.surface) == key and why_not(w) is None:
                    rewritable[w.id] = True
    mine = {}
    for name, doc in docs.items():
        for s in doc.sentences:
            for w in s.words:
                if _form(w.surface) == key and _job_own(w, jid) and w.id in rewritable:
                    mine[f'{name} s{s.index}.w{w.index}'] = _analysis(w)
    if not any(_form(w.surface) == key and _job_own(w, jid) for doc in docs.values() for s in doc.sentences
               for w in s.words):
        problems.append(f'the job analysed no {args["form"]}')
    if theirs is not None and len(set(mine.values())) > 1:
        problems.append(f'the job left {args["form"]} analysed {len(set(mine.values()))} ways')
    for d in ctx.project['documents']:
        after = docs[d['name']]
        for unit in [e for e, kind in units[d['name']] if kind == 'harmonize']:
            before = _as_of(ctx, project, d['id'], _just_before(unit['time']))
            now = {w.id: (s, w) for s in after.sentences for w in s.words}
            for s in before.sentences:
                for w in s.words:
                    hit = now.get(w.id)
                    if hit is None or _everything(w) == _everything(hit[1]):
                        continue
                    where = f'{d["name"]} s{s.index}.w{w.index}'
                    why = why_not(w)
                    if why is not None:
                        problems.append(f'{where}: harmonize changed a word that {why}')
                    elif not _job_own(hit[1], jid):
                        problems.append(f'{where}: harmonize left a word not the job\'s own')
                    elif _form(w.surface) == key and theirs is None:
                        problems.append(f'{where}: harmonize changed {args["form"]} while people analysed it '
                                        f'{len(people)} ways')
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
                if _pieces(x) and all(_persons(p) and not _job_piece(p, jid) for p in _pieces(x)):
                    # A person's own work since: no write of the job's.
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
