"""Three commas planted as AUX, one in each French document (survey item
14: a punctuation mark tagged PUNCT almost everywhere and something else a
few times). Shared by the
form-upos tasks' setups and validate files."""
import udplan

COMMAS = [('French 1', 's11.w2'), ('French 2', 's10.w3'), ('French 3', 's5.w8')]


def plant(ctx):
    for doc, ref in COMMAS:
        udplan.plant(ctx, [('set_field', {'document': doc, 'refs': [ref], 'field': 'upos', 'value': 'AUX'})])


def fix(ctx, which=COMMAS):
    for doc, ref in which:
        udplan.apply(ctx, [('set_field', {'document': doc, 'refs': [ref], 'field': 'upos', 'value': 'PUNCT'})])
