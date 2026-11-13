import igt_job_hand as H
import igtlib as L

FORM = 'я'
TARGETS = ('Lezgi text 1', 'Lezgi text 2')


def setup(ctx):
    """я left blank in the two texts the job is for, and analysed two ways by
    people elsewhere: the first two of the other texts' я glossed COP, the
    rest as the import left them ("was")."""
    cop = 0
    for d in ctx.project['documents']:
        name = d['name']
        for a, _ in H.words(ctx, name, form=FORM):
            if name in TARGETS:
                L.strip_analysis(ctx, name, a)
            elif cop < 2 and L.morphemes_of(L.raw(ctx, name), a):
                L.set_field(ctx, name, {f'{a}.m1': 'COP'}, verified=False)
                cop += 1
    assert cop == 2, 'two of the other texts\' я are glossed COP by a person'
