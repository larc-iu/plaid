import igt_job_hand as H
import igtlib as L


def setup(ctx):
    """Sentences 1 to 5 of Lezgi text 1 left blank: their words' analyses go."""
    for a, _ in H.words(ctx, 'Lezgi text 1', sentences=range(1, 6)):
        L.strip_analysis(ctx, 'Lezgi text 1', a)
