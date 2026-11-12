"""Checks an unattended job's run (tasks whose yaml says `job:` in place of
turns). Reads the documents with the assistant's own parser and the job's own
rules (plaid_agent.igt.job), so a word is a target, protected or the job's
exactly as the worker decides it.

Every job task:
- the job ended `done`,
- nothing protected changed: a word that was not a target keeps its analysis
  and its provenance, a translation a person wrote keeps its value,
- every word that changed was a target and is now the job's own analysis,
  machine-unverified with the job's id in provDetail (or was left blank),
- every translation that changed was a target and is now the job's own,
- no two entries the job made share a form and gloss, and none repeats an
  entry that was there before.

args:
  mode: stretch | harmonize
  document, sentences: (stretch) the target sentences, every target word of
    which is analysed or left, at least one analysed
  form: (harmonize) every word of this form the job analysed carries the one
    analysis people gave it (SPEC 8: a person's one analysis wins)
"""
from plaid_agent.core.job import canonical
from plaid_agent.igt.job import (form_key, job_owned, translation_state, unmade, word_analysis, word_state,
                                 word_target)
from plaid_agent.igt.project import load_document, load_project, parse_document

import common as c


def _gloss_of(project, v):
    return project.lexicon_field(v, 'gloss')


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
            if translation_state(s, project, jid) != translation_state(t, project, jid):
                if translation_state(s, project, jid) not in ('empty', 'machine') \
                        or translation_state(t, project, jid) != 'own':
                    problems.append(f'{d["name"]} s{s.index}: translation changed and is not the job\'s')
            words = {w.id: w for w in t.words}
            for w in s.words:
                x = words.get(w.id)
                if x is None:
                    problems.append(f'{d["name"]} s{s.index}.w{w.index}: gone')
                    continue
                same = canonical(word_analysis(w)) == canonical(word_analysis(x)) and word_state(w) == word_state(x)
                if same:
                    continue
                if not word_target(w):
                    problems.append(f'{d["name"]} s{s.index}.w{w.index}: not a target, changed')
                elif not job_owned(x, jid):
                    problems.append(f'{d["name"]} s{s.index}.w{w.index}: changed, not the job\'s own machine work')
    if args.get('mode') == 'stretch':
        doc = docs[args['document']]
        before = parse_document(c.baseline(next(d['id'] for d in ctx.project['documents']
                                                if d['name'] == args['document']), ctx.baseline_dir), project)
        targets = {w.id for s in before.sentences if s.index in args['sentences'] for w in s.words
                   if word_target(w)}
        for s in doc.sentences:
            for w in s.words:
                if w.id in targets:
                    if job_owned(w, jid):
                        analysed += 1
                    elif word_target(w):
                        left += 1
        if not analysed:
            problems.append('no target word was analysed')
    if args.get('mode') == 'harmonize':
        key = form_key(args['form'])
        people, mine = set(), {}
        for name, doc in docs.items():
            for s in doc.sentences:
                for w in s.words:
                    if form_key(w.surface) != key:
                        continue
                    if word_state(w) == 'protected':
                        people.add(canonical(unmade(word_analysis(w))))
                    elif job_owned(w, jid):
                        mine[f'{name} s{s.index}.w{w.index}'] = canonical(unmade(word_analysis(w)))
        if len(people) != 1:
            problems.append(f'the task wants one analysis by people of {args["form"]}, found {len(people)}')
        elif not mine:
            problems.append(f'the job analysed no {args["form"]}')
        else:
            (theirs,) = people
            off = sorted(a for a, k in mine.items() if k != theirs)
            if off:
                problems.append(f'not the people\'s analysis of {args["form"]}: {off}')
    seen = {}
    for v in project.vocabs:
        if v.get('borrowed'):
            continue
        gloss = _gloss_of(project, v)
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
