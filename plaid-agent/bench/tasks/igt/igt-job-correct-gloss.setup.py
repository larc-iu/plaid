import igt_job_hand as H
import igtlib as L

DOC = 'Lezgi text 4'


def setup(ctx):
    """Lezgi text 4's first я glossed DOG, verified: a person's value, wrong."""
    first = [w for w, _ in H.words(ctx, DOC, form='я')][0]
    L.set_field(ctx, DOC, {f'{first}.m1': 'DOG'}, verified=True)
    L.snap(ctx)
