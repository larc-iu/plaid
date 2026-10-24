"""How a lexicon entry's form is stored: without affix or clitic markers.

An entry's marker is drawn from its morph type ("-s" is a suffix "s", "ni=" a
proclitic "ni"), so every writer of an entry form passes the form and type it
was given through :func:`entry_form` and stores what comes back. The JS client
holds the same rule (``plaid-client-js/src/entryForms.js``), and
``tests/test_entry_forms_mirror.py`` compares the two answer by answer.

The morph types are FieldWorks' MoMorphType inventory, which LIFT and
.flextext need verbatim. The markers are each type's Prefix and Postfix as
FieldWorks spells a morph standing alone. The seven types left out of the
table (stem, root, circumfix, clitic, particle, phrase, discontiguous phrase)
have no marker in FieldWorks' data.
"""

import re

#: FieldWorks' morph types, the values a stored morph type may take.
MORPH_TYPES = (
    'stem', 'bound stem', 'root', 'bound root', 'prefix', 'suffix', 'infix', 'circumfix',
    'simulfix', 'suprafix', 'infixing interfix', 'prefixing interfix', 'suffixing interfix',
    'clitic', 'enclitic', 'proclitic', 'particle', 'phrase', 'discontiguous phrase',
)

_MARKERS = {
    'bound root': ('*', ''),
    'bound stem': ('*', ''),
    'enclitic': ('=', ''),
    'infix': ('-', '-'),
    'infixing interfix': ('-', '-'),
    'prefix': ('', '-'),
    'prefixing interfix': ('', '-'),
    'proclitic': ('', '='),
    'simulfix': ('=', '='),
    'suffix': ('-', ''),
    'suffixing interfix': ('-', ''),
    'suprafix': ('~', '~'),
}

# The one plain type each pair of "-" and "=" markers names. The interfixes
# share their markers with a plainer type, so markers alone never name one,
# and "*" and "~" are left out because both also occur in forms as themselves
# (a reconstructed "*kwa").
_TYPE_BY_MARKERS = {
    ('-', ''): 'suffix',
    ('', '-'): 'prefix',
    ('-', '-'): 'infix',
    ('=', ''): 'enclitic',
    ('', '='): 'proclitic',
    ('=', '='): 'simulfix',
}

_MARKED = re.compile(r'([-=]?)(.+?)([-=]?)', re.DOTALL)


def decorate_with_affix_markers(morph_type, form):
    """A form written the way FieldWorks writes a morph standing alone: "-ar"
    for a suffix, "ka-" for a prefix, unchanged for a stem, for a type outside
    the table or none."""
    if form is None or form == '':
        return form
    marks = _MARKERS.get(str(morph_type if morph_type is not None else '').lower())
    return f'{marks[0]}{form}{marks[1]}' if marks else form


def _strips(form, morph_type):
    before, after = _MARKERS.get(morph_type, ('', ''))
    if (before + after and len(form) > len(before) + len(after)
            and form.startswith(before) and form.endswith(after)):
        return form[len(before):len(form) - len(after)]
    return None


def _marked_type(form):
    m = _MARKED.fullmatch(form)
    morph_type = m and _TYPE_BY_MARKERS.get((m.group(1), m.group(3)))
    return {'form': m.group(2), 'morphType': morph_type} if morph_type else None


def entry_form(morph_type, form):
    """The form and morph type an entry stores, from the form and type a
    person, a file or a model gave, as ``{'form', 'morphType'}``.

    A form carrying its type's markers loses them ("-s" of a suffix is "s"). A
    form carrying "-" or "=" markers that name a type loses them and takes
    that type, whatever type came with it: "-s" given as a stem, or with no
    type, is the suffix "s". Any other form is kept as written with the type
    it came with, returned as given ("*kwa" with no type stays "*kwa").
    """
    if not isinstance(form, str) or form == '':
        return {'form': form, 'morphType': morph_type}
    own = morph_type.lower() if isinstance(morph_type, str) else ''
    bare = _strips(form, own) if own in MORPH_TYPES else None
    if bare is not None:
        return {'form': bare, 'morphType': morph_type}
    return _marked_type(form) or {'form': form, 'morphType': morph_type}
