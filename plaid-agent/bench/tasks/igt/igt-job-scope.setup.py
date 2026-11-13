import igt_job_hand as H
import igtlib as L

FORM = 'я'
TARGETS = ('Lezgi text 1',)


def setup(ctx):
    """я left blank in the text the job is for (Lezgi text 1, seven of them),
    and analysed two ways by people elsewhere: of Lezgi text 4's two я, the
    first glossed COP by a person, the second as the import left it ("was").
    No other text holds я."""
    cop = 0
    for d in ctx.project['documents']:
        name = d['name']
        for a, _ in H.words(ctx, name, form=FORM):
            if name in TARGETS:
                L.strip_analysis(ctx, name, a)
            elif cop < 1 and L.morphemes_of(L.raw(ctx, name), a):
                L.set_field(ctx, name, {f'{a}.m1': 'COP'}, verified=False)
                cop += 1
    assert cop == 1, 'one of the other texts\' я is glossed COP by a person'
    held(ctx)


def held(ctx):
    """What the task is about, read back as the job reads it: я present and
    unanalysed in every document the job covers, and people's analyses of
    я elsewhere in two ways at least (the job's own index, IgtRunner.people_of)."""
    from plaid_agent.igt.job import IgtRunner, form_key, word_state
    from plaid_agent.igt.project import load_document, load_project
    project = load_project(ctx.client, ctx.project['id'])
    ways = set()
    for d in ctx.project['documents']:
        doc = load_document(ctx.client, project, d['id'])
        if d['name'] in TARGETS:
            mine = [w for s in doc.sentences for w in s.words if form_key(w.surface) == form_key(FORM)]
            assert mine, f'{d["name"]} holds я'
            assert all(word_state(w) == 'unanalyzed' for w in mine), f'every я of {d["name"]} is unanalysed'
        else:
            ways |= set(IgtRunner.people_of(doc).get(form_key(FORM), {}))
    assert len(ways) >= 2, f'people analysed я in two ways at least, not {len(ways)}'
