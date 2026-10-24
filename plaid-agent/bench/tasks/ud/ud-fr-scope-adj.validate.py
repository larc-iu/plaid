import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _answers import reply  # noqa: E402


def right(ctx):
    return reply('In French 1 and French 2 there are **69** words tagged ADJ. The most frequent adjective '
                 'lemma is *français* (4 times).')


def wrong_whole_project(ctx):
    return reply('There are 101 words tagged ADJ; the most frequent lemma is français.')


def wrong_lemma(ctx):
    return reply('There are 69 ADJ words; the most frequent lemma is premier.')
