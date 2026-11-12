"""IGT: sentences segmented and glossed, scored against the gold the fixture
holds. The bench's other checkers say pass or fail. This one reports how
much of the analysis is right, because that is what glossing is judged by
(FABLE-REVIEW 2026-11-12, "what the bench does not measure").

The gold is the snapshot's own document (common.BASELINE), which the build
imported from the SIGMORPHON 2023 data: segmentation and a gloss per
morpheme, as the shared task published them. The task's setup strips the
analysis of the target sentences, so the gold is what was there before it.

args:
  document:   the document the target sentences are in
  sentences:  the target sentence numbers, e.g. [1, 2, 3, 4, 5]
  field:      the morpheme field glossed (default Gloss)
  min_score:  the score a pass needs (default 0.5)

Measures, all over the target sentences' words:
  words:            the words scored
  seg_exact:        the share of words whose morpheme forms are the gold's,
                    in order
  form_p, form_r, form_f1: morpheme forms per word, as multisets
  gloss_p, gloss_r, gloss_f1: (form, gloss) pairs per word, as multisets,
                    so a gloss counts only on the form it belongs to
  score:            gloss_f1, the number the task reports
  consistency:      the share of glossed morphemes whose form is analysed
                    elsewhere in the project (outside the target sentences)
                    that carry the gloss most often given there, or null when
                    none is
  collateral:       any other change in the project, which fails the run as
                    in every checker (links included: they were not asked for)
  plan_status

Pass when a plan was applied, nothing else changed, and score >= min_score.
"""
from collections import Counter

import common as c
from exact_changes import plan_items


def _analyses(values, sentences, field):
    """{word address: [(form, gloss), ...]} for the words of ``sentences``."""
    out = {}
    for k, v in values.items():
        parts = k.split('.')
        if ':' in k or len(parts) != 2 or int(parts[0][1:]) not in sentences:
            continue
        ms = []
        i = 1
        while f'{k}.m{i}:form' in values:
            ms.append((str(values[f'{k}.m{i}:form'] or '').lower(), values.get(f'{k}.m{i}:{field}')))
            i += 1
        out[k] = ms
    return out


def _prf(gold: Counter, got: Counter):
    tp = sum((gold & got).values())
    p = tp / sum(got.values()) if got else 0.0
    r = tp / sum(gold.values()) if gold else 0.0
    return p, r, (2 * p * r / (p + r) if p + r else 0.0)


def score(gold_values, now_values, sentences, field='Gloss'):
    """The measures above, from two igt_values maps (gold, and the result)."""
    gold = _analyses(gold_values, sentences, field)
    now = _analyses(now_values, sentences, field)
    words = sorted(gold)
    seg = sum(1 for w in words if [f for f, _ in now.get(w, [])] == [f for f, _ in gold[w]])
    gf, nf, gg, ng = Counter(), Counter(), Counter(), Counter()
    for w in words:
        gf.update((w, f) for f, _ in gold[w])
        nf.update((w, f) for f, _ in now.get(w, []))
        gg.update((w, f, g) for f, g in gold[w] if g)
        ng.update((w, f, g) for f, g in now.get(w, []) if g)
    fp, fr, ff = _prf(gf, nf)
    gp, gr, gfs = _prf(gg, ng)
    # How the rest of the project glosses each form.
    elsewhere = {}
    for k, v in now_values.items():
        if not k.endswith(':form') or int(k.split('.')[0][1:]) in sentences:
            continue
        g = now_values.get(k[:-len(':form')] + f':{field}')
        if g:
            elsewhere.setdefault(str(v or '').lower(), Counter())[g] += 1
    judged = [(f, g) for w in words for f, g in now.get(w, []) if g and f in elsewhere]
    agree = sum(1 for f, g in judged if elsewhere[f].most_common(1)[0][0] == g)
    r3 = lambda x: round(x, 3)  # noqa: E731
    return {'words': len(words), 'seg_exact': r3(seg / len(words)) if words else None,
            'form_p': r3(fp), 'form_r': r3(fr), 'form_f1': r3(ff),
            'gloss_p': r3(gp), 'gloss_r': r3(gr), 'gloss_f1': r3(gfs), 'score': r3(gfs),
            'consistency': r3(agree / len(judged)) if judged else None}


def check(ctx):
    a = ctx.args
    field = a.get('field', 'Gloss')
    sentences = set(a['sentences'])
    doc = next(d for d in ctx.project['documents'] if d['name'] == a['document'])
    gold = c.igt_values(c.baseline(doc['id']))
    now = c.igt_values(ctx.client.documents.get(doc['id'], include_body=True))
    measures = score(gold, now, sentences, field)

    # Everything but the target words' morphemes (their forms, glosses and
    # stamps) is held to the state after setup.
    changes = c.project_changes(ctx, c.igt_values)
    flat = {f'{name}|{k}': v for name, ch in changes.items() for k, v in ch.items()}
    flat.update(c.guideline_changes(ctx))

    def target(key):
        name, addr = key.split('|', 1) if '|' in key else ('', key)
        parts = addr.split(':', 1)[0].split('#', 1)[0].split('.')
        if name != a['document'] or len(parts) != 3 or int(parts[0][1:]) not in sentences:
            return False
        what = addr.split(':', 1)[1] if ':' in addr else ''
        return what.split('#', 1)[0] in ('form', field)

    extra = sorted(k for k in flat if not target(k))
    plans = plan_items(ctx.conversation)
    applied = 'applied' in [p.get('status') for p in plans]
    passed = applied and not extra and measures['score'] >= a.get('min_score', 0.5)
    return c.result(passed, **measures, collateral={'count': len(extra), 'first': extra[:8]},
                    plan_status=[p.get('status') for p in plans])
