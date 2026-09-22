"""The tool table the model sees, and the dispatch behind it.

Every tool an interlinear assistant may call is declared here once, beside the
function that implements it, and nowhere else. A tool that plans a change says
so in the first word of its description, which is what makes it one: there is
no second list to keep in step with this one.

This is the last module in the app to be imported: it reads every tool module,
so nothing here may be imported back by one of them.
"""

from typing import Any, Dict, List

from ..core import sandbox as _sandbox
from ..core import guidelines as _guidelines
from ..core import filetools, webtools
from ..core.filetools import t_read_file
from ..core.webtools import t_read_url, t_web_search
from ..core.guidelines import (t_add_guideline, t_read_guideline, t_revise_guideline,
                               t_rewrite_guideline)
from ..core.limits import MAX_SENTENCES_PER_READ, OVERVIEW_DOCS
from ..core.tools import fn, limit_arg, run_tool, tools_for as core_tools_for

from .bulk import (t_copy_to_orthography, t_delete_entry, t_merge_entries, t_rename_document,
                   t_rename_entry, t_replace_in_field, t_respell_all, t_set_analysis_for_form,
                   t_set_field_for_form)
from .lexicon import (t_add_sense, t_create_entry, t_free_sense, t_make_sense_of, t_move_sense,
                      t_order_homographs, t_promote_example, t_remove_example, t_set_entry_field)
from .query import t_query, t_query_help
from ..core.history import recent_changes as t_recent_changes
from .reads import (t_analyses_of, t_check_consistency, t_concordance, t_lexicon_entry,
                    t_list_documents, t_plan_status, t_project_overview, t_read_document,
                    t_read_lexicon, t_search)
from .sandbox import t_code_help, t_run_code
from .shape import (t_append_text, t_delete_word, t_merge_sentences, t_merge_words,
                    t_retype_sentence, t_split_sentence, t_split_word)
from .stats import (t_check_integrity, t_check_lexicon, t_corpus_stats, t_frequency_list,
                    t_sequence_search, t_worklist)
from .tools import (t_add_comment, t_comments, t_confirm, t_create_document, t_discard_analysis,
                    t_discard_plan, t_drop_planned, t_link_entry, t_link_phrase, t_respell,
                    t_restore_document, t_set_analysis, t_set_document_metadata, t_set_field,
                    t_set_morpheme, t_set_orthography, t_unlink_entry, t_unlink_phrase)
from .workspace import Workspace

# Offered only where the monty worker binary is present, and only where the
# operator configured a search backend (see tools_for): a model that cannot
# run code or look something up is never told that it can.
CODE_TOOLS = _sandbox.NAMES
WEB_TOOLS = ('web_search', 'read_url')
FILE_TOOLS = filetools.NAMES


# --- schema + dispatch ----------------------------------------------------------

_fn = fn


_DOC = {'type': 'string', 'description': 'Document id or exact name (see project_overview).'}
_GLOSS = {'type': 'string', 'description': 'Singles out one of several entries with the same form: a value one of '
                                           'its fields has (e.g. its gloss).'}
_ENTRY_FORM = {'type': 'string',
               'description': 'A headword, with an optional "#" and the number shown beside it. One segment '
                              'is a headword ("gam#2", the second spelled that way), two or more a sense '
                              '("kwatha#1.2", "gam#2.1.3"). A bare "kwatha" is the headword. read_lexicon '
                              'shows every number.'}
_ENTRY_ADDR = {'entry_form': _ENTRY_FORM,
               'lexicon': {'type': 'string', 'description': 'Lexicon name (needed only when the project has several).'},
               'entry_id': {'type': 'string'}}

_REFS = {'type': 'array', 'items': {'type': 'string'},
         'description': 'Positional references, e.g. ["s3.w2", "s3.w4"]. Words are sN.wN, morphemes sN.wN.mN, sentences sN.'}
_MORPHEMES = {'type': 'array', 'items': {'type': 'object', 'properties': {
    'form': {'type': 'string'}, 'type': {'type': 'string'},
    'fields': {'type': 'object', 'additionalProperties': {'type': 'string'}}}, 'required': ['form']}}

TOOLS = [
    _fn('project_overview',
        'The project: its annotation fields by scope (Word / Morpheme / Sentence), orthographies, lexicons, and the '
        f'list of documents, the first {OVERVIEW_DOCS} by name (list_documents pages and filters the rest). '
        'Call this first.', {}, []),
    _fn('list_documents',
        'The documents by name, a page at a time, optionally filtered by a name substring and/or a document metadata '
        'value (metadata_field + value; an empty value lists documents lacking it).',
        {'pattern': {'type': 'string'}, 'metadata_field': {'type': 'string'}, 'value': {'type': 'string'},
         'limit': limit_arg('list_documents', 'Documents to show'),
         'offset': {'type': 'integer'}}, []),
    _fn('read_document',
        'Read a document as compact interlinear text: baseline sentences, sentence fields, and one line per word '
        'with its segmentation, glosses, word fields, orthographies, and lexicon links. Up to '
        f'{MAX_SENTENCES_PER_READ} sentences per '
        'call, fewer when they are long: the header says which were shown and where to continue.',
        {'document': _DOC,
         'from_sentence': {'type': ['integer', 'string'],
                           'description': 'First sentence to show: 3 or "s3" (default 1).'},
         'to_sentence': {'type': ['integer', 'string'],
                         'description': 'Last sentence to show: 8 or "s8".'}},
        ['document']),
    _fn('search',
        'Find words, morphemes, field values, or lexicon entries matching a pattern (case-insensitive substring, '
        'or a regex). Returns positional references with each hit\'s word line and sentence. Scans every '
        'document unless one is named. (For items LACKING a value use worklist; for aligned context use concordance.)',
        {'pattern': {'type': 'string'},
         'where': {'type': 'string', 'description': '"baseline" (word forms, default), "morpheme" (morpheme forms), '
                                                    '"lexicon" (entries), or a field name (e.g. "Gloss", "Translation").'},
         'document': _DOC,
         'regex': {'type': 'boolean', 'description': 'Treat pattern as a regular expression.'}, 'case_sensitive': {'type': 'boolean', 'description': 'Match case too (off by default: "ar" finds "Ar").'},
         'limit': limit_arg('search', 'Max hits to return')},
        ['pattern']),
    _fn('read_lexicon',
        'List lexicon entries (form, morph type, and their fields such as gloss), optionally filtered by a '
        'substring pattern over the whole entry line. Senses are drawn under their entry with the number '
        'they are shown with.',
        {'lexicon': {'type': 'string', 'description': 'Lexicon name (needed only when the project has several).'},
         'pattern': {'type': 'string'},
         'limit': {'type': 'integer', 'description': 'Max entries (default 80).'}},
        []),
    _fn('set_field',
        'PLAN: set a field\'s value on words, morphemes, or sentences (the references must match the field\'s '
        'scope). Empty value clears it. Nothing is written until the user approves the plan.',
        {'document': _DOC, 'refs': _REFS, 'field': {'type': 'string'}, 'value': {'type': 'string'}},
        ['document', 'refs', 'field', 'value']),
    _fn('set_analysis',
        'PLAN: replace a word\'s morpheme segmentation and morpheme-level fields. Morphemes are given in order; '
        'each has a form, an optional type (stem, root, prefix, suffix, infix, enclitic, proclitic, ...), and '
        'fields mapping morpheme field names to values, e.g. [{"form":"kitab","type":"stem","fields":{"Gloss":"book"}}, '
        '{"form":"lar","type":"suffix","fields":{"Gloss":"PL"}}]. REPLACES the word\'s whole chain: every existing '
        'morpheme field value on it, human-made ones included, is dropped. To change one morpheme\'s value keep the '
        'chain and use set_field with sN.wN.mN; to change one morpheme\'s form or type, set_morpheme. Several words '
        'at once: analyses=[{"ref":"s3.w1","morphemes":[...]}, ...] (one call per sentence, not per word).',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The word, sN.wN.'},
         'morphemes': _MORPHEMES,
         'analyses': {'type': 'array', 'description': 'Several words at once: [{ref, morphemes}, ...].',
                      'items': {'type': 'object', 'properties': {'ref': {'type': 'string'}, 'morphemes': _MORPHEMES},
                                'required': ['ref', 'morphemes']}}},
        ['document']),
    _fn('set_morpheme',
        'PLAN: change one morpheme\'s stored form and/or type in place, keeping the chain and every value on it '
        '(e.g. make sN.wN.m2 an enclitic). type "" clears the type.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The morpheme, sN.wN.mN.'},
         'form': {'type': 'string'}, 'type': {'type': 'string'}}, ['document', 'ref']),
    _fn('set_orthography',
        'PLAN: set an orthography value (an alternative transcription tier, not the baseline) on words.',
        {'document': _DOC, 'refs': _REFS, 'orthography': {'type': 'string'}, 'value': {'type': 'string'}},
        ['document', 'refs', 'orthography', 'value']),
    _fn('respell',
        'PLAN: change the BASELINE spelling of one word (its analysis, glosses, and links are kept; a lone '
        'morpheme form spelt like the word follows it unless morpheme_forms=false). For an alternative '
        'transcription tier use set_orthography.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The word, sN.wN.'}, 'new_text': {'type': 'string'},
         'morpheme_forms': {'type': 'boolean'}},
        ['document', 'ref', 'new_text']),
    _fn('link_entry',
        'PLAN: link words or morphemes to a lexicon entry, by the entry\'s form ("ама", or "ама#2" for homograph 2), '
        'or entry_id (also the id returned by create_entry). Replaces the item\'s own link; a multi-word expression '
        'the word belongs to is separate and stays (link_phrase / unlink_phrase for those).',
        {'document': _DOC, 'refs': _REFS, 'entry_form': {'type': 'string'}, 'lexicon': {'type': 'string'},
         'entry_id': {'type': 'string'}, 'entry_gloss': _GLOSS},
        ['document', 'refs']),
    _fn('unlink_entry', 'PLAN: remove the own lexicon link of words or morphemes (not a multi-word expression: '
                        'unlink_phrase).',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('link_phrase',
        'PLAN: link two or more words of one sentence to ONE lexicon entry as a multi-word expression (an idiom, a '
        'compound written apart, a phrasal verb; reads show it as mwe=entry (w2+w3)). The words keep their own '
        'links. A new phrase entry is created with create_entry (type "phrase") and linked here in the same plan.',
        {'document': _DOC, 'refs': _REFS, 'entry_form': {'type': 'string'}, 'lexicon': {'type': 'string'},
         'entry_id': {'type': 'string'}, 'entry_gloss': _GLOSS},
        ['document', 'refs']),
    _fn('unlink_phrase',
        'PLAN: remove a multi-word expression (the link its member words share); their own links stay. refs: '
        'any member word (several where a word sits in more than one expression).',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('create_entry',
        'PLAN: add a lexicon entry. fields maps entry field names (e.g. "gloss", "pos") to values; type is the '
        'morph type (stem, suffix, enclitic, ...). The returned entry_id can be used by link_entry in the same '
        'plan. Use add_sense for a sense of an existing entry.',
        {'form': {'type': 'string'}, 'lexicon': {'type': 'string'},
         'fields': {'type': 'object', 'additionalProperties': {'type': 'string'}}, 'type': {'type': 'string'}},
        ['form']),
    _fn('set_entry_field',
        'PLAN: set a field (e.g. gloss) on a lexicon entry. A field that holds a reference to another entry '
        '(project_overview marks them) takes that entry\'s form or id, not free text; passing an empty value '
        'clears it, and a field holding several appends. Where an entry sits, its examples and its headword are '
        'not fields: use add_sense, make_sense_of, move_sense, promote_example or rename_entry.',
        {'field': {'type': 'string'}, 'value': {'type': 'string'}, 'entry_form': _ENTRY_FORM,
         'lexicon': {'type': 'string'}, 'entry_id': {'type': 'string'}, 'entry_gloss': _GLOSS},
        ['field', 'value']),
    _fn('concordance',
        'Every occurrence of a morpheme form (default), word form, or field value (whole-form match, case-insensitive; '
        'regex=true for partial matches), with aligned context: the '
        'word\'s segmentation and morpheme glosses with the hit in [brackets], the neighbouring words, and a '
        'tally of the distinct word patterns the hit appears in. Use this for morphotactic and distributional '
        'questions (what precedes/follows X, does X vary by context) instead of reading whole documents.',
        {'pattern': {'type': 'string'},
         'where': {'type': 'string', 'description': '"morpheme" (default), "baseline" (word forms), or a Word/Morpheme field name.'},
         'document': _DOC, 'regex': {'type': 'boolean'}, 'case_sensitive': {'type': 'boolean', 'description': 'Match case too (off by default: "ar" finds "Ar").'},
         'limit': {'type': 'integer', 'description': 'Max occurrences to list (default 60); the pattern tally always covers all.'}},
        ['pattern']),
    _fn('analyses_of',
        'How a form has been analyzed so far, as a word (segmentation, glosses, links) and as a morpheme (type, '
        'glosses, link, position in the word): each distinct analysis with its count and example references. '
        'Check this before proposing an analysis, and follow the majority unless there is reason not to. Pass '
        'forms (a list, up to 40) to check every word of a sentence in one call.',
        {'form': {'type': 'string'}, 'forms': {'type': 'array', 'items': {'type': 'string'}}, 'document': _DOC}, []),
    _fn('lexicon_entry',
        'One lexicon entry in full: all its fields, how many words and morphemes link to it, and example '
        'occurrences. It also says where the entry sits, the senses under it, what refers to it, and its '
        'promoted usage examples with their numbers.',
        {'entry_form': _ENTRY_FORM, 'lexicon': {'type': 'string'}, 'entry_id': {'type': 'string'},
         'entry_gloss': _GLOSS, 'examples': {'type': 'integer', 'description': 'Example occurrences to show (default 3).'}},
        []),
    _fn('check_consistency',
        'A consistency report for a field: values that are case/spelling variants of one another, forms that carry '
        'several different values, and items annotated but not linked to the lexicon (or linked but empty).',
        {'field': {'type': 'string'}, 'document': _DOC}, ['field']),
    _fn('recent_changes',
        'The newest entries of the change history: who changed what and when, including plans this assistant applied. '
        'Each line ends with as_of=<instant>, the moment right after that change, which restore_document takes.',
        {'document': _DOC, 'limit': limit_arg('recent_changes', 'Entries to show'),
         'since': {'type': 'string', 'description': 'Only changes at or after this date (YYYY-MM-DD) or timestamp.'},
         'user': {'type': 'string', 'description': 'Only changes by this person (name or email substring).'}}, []),
    _fn('comments',
        'The comments people have left (not annotation data: notes to each other). Whole project, one document, '
        'or one item (document + ref, plus field for a comment on one of its values). Oldest first.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'sN, sN.wN, or sN.wN.mN.'},
         'field': {'type': 'string'}, 'limit': limit_arg('comments', 'Newest entries to show')},
        []),
    _fn('add_comment',
        'PLAN: post a comment under the user\'s name on a document (no ref), a sentence, a word, a morpheme, or, '
        'with field, on one of their values. Comments are notes to people; they change no annotation.',
        {'document': _DOC, 'body': {'type': 'string'}, 'ref': {'type': 'string', 'description': 'sN, sN.wN, or sN.wN.mN.'},
         'field': {'type': 'string'}}, ['document', 'body']),
    _fn('restore_document',
        'PLAN: put a document back as it was at a moment in its history (as_of, an instant recent_changes prints), '
        'every layer at once, in one operation the user can undo the same way. The plan lists what would change. '
        'Maintainers only, and a plan of its own.',
        {'document': _DOC, 'as_of': {'type': 'string', 'description': 'ISO-8601 instant, e.g. 2026-09-05T18:45:49Z.'}},
        ['document', 'as_of']),
    _fn('plan_status', 'List the changes planned so far in this turn.', {}, []),
    _fn('set_document_metadata',
        'PLAN: set one of the project\'s document metadata fields (see project_overview) on a document.',
        {'document': _DOC, 'field': {'type': 'string'}, 'value': {'type': 'string'}}, ['document', 'field', 'value']),
    _fn('create_document',
        'PLAN: create a new document from raw text, one sentence per line; words are tokenized like the editor does. '
        'metadata maps document metadata field names to values.',
        {'name': {'type': 'string'}, 'text': {'type': 'string'},
         'metadata': {'type': 'object', 'additionalProperties': {'type': 'string'}}},
        ['name', 'text']),
    _fn('discard_plan', 'Drop every change planned so far in this turn.', {}, []),
    _fn('drop_planned', 'Drop some of the planned changes by their plan_status numbers; the rest stay.',
        {'indexes': {'type': 'array', 'items': {'type': 'integer'}}}, ['indexes']),
    _fn('confirm',
        'PLAN: mark annotations awaiting review as verified, after checking them: machine-made ones (other services, '
        'earlier assistant plans; ~ in reads) and contributors\' work (^ in reads); see worklist kind="unverified" / '
        '"contributed". refs: sentences, words, or morphemes (a sentence covers its words); field: only that '
        'field\'s values; no refs: the whole document. Give `documents` instead of `document` to cover '
        'several at once: a list of names, or ["all"] for every document with something waiting (up to 100).',
        {'document': _DOC, 'refs': _REFS, 'field': {'type': 'string'},
         'documents': {'type': 'array', 'items': {'type': 'string'},
                       'description': 'Several documents, by id or name; or ["all"].'}}, []),
    _fn('discard_analysis',
        'PLAN: delete the unverified machine-made analysis of words (their machine links, values, and morphemes); '
        'human-made, contributed, and verified pieces stay. refs: words or sentences.',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('add_sense',
        'PLAN: add a sense under an entry, numbered after the senses it already has. The new sense carries the '
        'entry\'s headword unless form says otherwise.',
        {**_ENTRY_ADDR, 'entry_gloss': _GLOSS,
         'fields': {'type': 'object', 'additionalProperties': {'type': 'string'},
                    'description': 'Field values for the new sense, e.g. {"gloss": "to simmer"}.'},
         'form': {'type': 'string', 'description': 'A form for the sense, when it differs from the headword.'},
         'type': {'type': 'string', 'description': 'Morph type (stem, suffix, ...).'}},
        []),
    _fn('move_sense',
        'PLAN: put a sense at the number it should be shown with among its siblings, renumbering them to match. '
        'Senses count from 1 at every level.',
        {'number': {'type': 'string', 'description': 'Its place among its own siblings, counting from 1. The '
                                                     'last segment of a dotted number is taken, so "2" and '
                                                     '"1.2" both mean second among its siblings.'},
         **_ENTRY_ADDR, 'entry_gloss': _GLOSS},
        ['number']),
    _fn('make_sense_of',
        'PLAN: move an entry, with everything under it, to sit as a sense of another entry of the same lexicon.',
        {'under_form': {'type': 'string', 'description': 'The entry it should sit under.'},
         'under_id': {'type': 'string'}, **_ENTRY_ADDR, 'entry_gloss': _GLOSS},
        []),
    _fn('free_sense',
        'PLAN: make a sense a headword of its own, keeping the senses below it.',
        {**_ENTRY_ADDR, 'entry_gloss': _GLOSS}, []),
    _fn('promote_example',
        'PLAN: mark a word in a document as a usage example of an entry. The example is a reference, so it '
        'follows the word and is shown with its sentence.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'One word reference, e.g. "s3.w2".'},
         **_ENTRY_ADDR, 'entry_gloss': _GLOSS},
        ['document', 'ref']),
    _fn('order_homographs',
        'PLAN: set the order of the headwords spelled the same. That order is the first segment of the number '
        'they and all their senses are shown with, so it renumbers the whole group. Name every one of them, in '
        'the order they should be numbered, by the number each is shown with now (or by id).',
        {'order': {'type': 'array', 'items': {'type': 'string'},
                   'description': 'Every headword of the group, in their new order, e.g. ["2", "1", "3"].'},
         **_ENTRY_ADDR, 'entry_gloss': _GLOSS},
        ['order']),
    _fn('remove_example',
        'PLAN: drop one of an entry\'s usage examples, by the number lexicon_entry shows beside it.',
        {'index': {'type': 'integer', 'description': 'The example\'s position, as lexicon_entry lists it.'},
         **_ENTRY_ADDR, 'entry_gloss': _GLOSS},
        ['index']),
]

_IMPL = {
    'project_overview': t_project_overview, 'read_document': t_read_document, 'search': t_search,
    'list_documents': t_list_documents,
    'read_lexicon': t_read_lexicon,
    'set_field': t_set_field, 'set_analysis': t_set_analysis, 'set_morpheme': t_set_morpheme,
    'set_orthography': t_set_orthography,
    'respell': t_respell, 'link_entry': t_link_entry, 'unlink_entry': t_unlink_entry,
    'link_phrase': t_link_phrase, 'unlink_phrase': t_unlink_phrase,
    'create_entry': t_create_entry, 'set_entry_field': t_set_entry_field, 'discard_plan': t_discard_plan,
    'concordance': t_concordance, 'analyses_of': t_analyses_of, 'lexicon_entry': t_lexicon_entry,
    'check_consistency': t_check_consistency, 'recent_changes': t_recent_changes, 'plan_status': t_plan_status,
    'comments': t_comments, 'add_comment': t_add_comment, 'restore_document': t_restore_document,
    'set_document_metadata': t_set_document_metadata, 'create_document': t_create_document,
    'confirm': t_confirm, 'discard_analysis': t_discard_analysis, 'drop_planned': t_drop_planned,
    'add_sense': t_add_sense, 'move_sense': t_move_sense, 'make_sense_of': t_make_sense_of,
    'free_sense': t_free_sense, 'promote_example': t_promote_example, 'remove_example': t_remove_example,
    'order_homographs': t_order_homographs,
}



def call_tool(ws: Workspace, name: str, args: Dict[str, Any]) -> str:
    """Run one tool. Every failure comes back as text for the model."""
    fn = _IMPL.get(name)
    if not fn:
        return f'Unknown tool {name}'
    return run_tool(ws, name, fn, args)


_ENTRY = {'entry_form': {'type': 'string'}, 'lexicon': {'type': 'string'}, 'entry_id': {'type': 'string'},
          'entry_gloss': _GLOSS}

TOOLS += [
    _fn('corpus_stats',
        'Totals and coverage: documents, sentences, words, distinct forms, hapax, type/token ratio, morphemes, the '
        'share of words analysed and linked, and every field\'s fill rate. by="document" gives a per-document '
        'table (with metadata columns); by=<metadata field> (e.g. "Genre") breaks the corpus down by that field.',
        {'document': _DOC, 'by': {'type': 'string'}}, []),
    _fn('frequency_list',
        'Ranked counts with document dispersion for wordforms (default), morpheme forms, or a field\'s values.',
        {'what': {'type': 'string', 'description': '"wordform" (default), "morpheme", or a field name.'},
         'document': _DOC, 'limit': limit_arg('frequency_list', 'Rows'),
         'min_count': {'type': 'integer'}}, []),
    _fn('worklist',
        'The unfinished work, grouped by form and ordered by frequency: kind="unlinked" (no lexicon link), '
        '"unglossed" (no value in `field`, default the first morpheme field), "unanalyzed" (no analysis at all), '
        '"unverified" (annotations awaiting review: machine-made and unconfirmed, or a contributor\'s), or '
        '"contributed" (contributors\' unreviewed work only; user= narrows to one person). Use this to decide what '
        'to do next. Across the project each form shows a few examples; NAME A DOCUMENT and it lists every '
        'reference instead, which is the list to plan from and saves reading the document to find them.',
        {'kind': {'type': 'string', 'enum': ['unlinked', 'unglossed', 'unanalyzed', 'unverified', 'contributed']},
         'field': {'type': 'string'},
         'level': {'type': 'string', 'enum': ['word', 'morpheme'], 'description': 'For unlinked: which level to list (default morpheme when there is a morpheme layer). For unglossed the field\'s scope decides.'},
         'user': {'type': 'string', 'description': 'For contributed: only this contributor (their user id, an email).'},
         'document': _DOC, 'limit': limit_arg('worklist', 'Rows to show')}, []),
    _fn('check_lexicon',
        'Lexicon hygiene report, worst first with counts. section: "unused" (entries never linked), "fields" (missing '
        'gloss/pos), "homographs" (same form; groups with the same gloss first), "near" (forms one character apart), '
        '"glosses" (lexicon gloss disagrees with the corpus), "spread" (one corpus gloss over several entries), '
        '"stale" (link form no longer contains the entry form), "single" (attested in one document), "refs" (an '
        'entry whose sense or reference points at an entry that is gone), or "all" (default, each section '
        'capped).',
        {'lexicon': {'type': 'string'}, 'section': {'type': 'string'}}, []),
    _fn('check_integrity',
        'Data-shape report: segmentations that do not add up to the word, duplicate and empty sentences, non-NFC '
        'text, mixed apostrophe characters, and unusual characters in the baseline. Reads every document; on a large '
        'project name one.',
        {'document': _DOC}, []),
    _fn('sequence_search',
        'Sentences containing a sequence of words, each described by conditions on its form, morphemes, morph type, '
        'or field values, e.g. [{"POS":"v"},{"POS":"n"}] or [{"Gloss":"ERG"},{"form":"ava"}]; conditions match whole '
        'values (regex=true for patterns). adjacent=false lets other words come between, in order. Counts are '
        'sentences (first match per sentence). For constituent-order and construction questions.',
        {'sequence': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': {'type': 'string'}}},
         'adjacent': {'type': 'boolean'}, 'document': _DOC, 'regex': {'type': 'boolean'},
         'limit': {'type': 'integer'}}, ['sequence']),
    _fn('replace_in_field',
        'PLAN: substitute inside every value of a field, project-wide or in one document: substring by default, '
        'whole=true for exact values, regex=true for patterns with backreferences (\\1). field="morpheme form" '
        'rewrites stored morpheme forms instead of a field. One call plans every change; the plan lists each.',
        {'field': {'type': 'string'}, 'pattern': {'type': 'string'}, 'replacement': {'type': 'string'},
         'regex': {'type': 'boolean'}, 'case_sensitive': {'type': 'boolean', 'description': 'Match case too (off by default: "ar" finds "Ar").'}, 'whole': {'type': 'boolean', 'description': 'Match the whole value only.'}, 'document': _DOC},
        ['field', 'pattern', 'replacement']),
    _fn('respell_all',
        'PLAN: change the baseline spelling of every word matching a pattern (an orthography change), keeping each '
        'word\'s analysis, glosses, and links. The same replacement is carried into the stored morpheme forms of '
        'those words (morpheme_forms=false to leave them) and into lexicon headwords (lexicon=false to leave them; '
        'the pattern is applied to every entry, not only linked ones). Patterns apply within words only.',
        {'pattern': {'type': 'string'}, 'replacement': {'type': 'string'}, 'regex': {'type': 'boolean'}, 'case_sensitive': {'type': 'boolean', 'description': 'Match case too (off by default: "ar" finds "Ar").'},
         'whole': {'type': 'boolean', 'description': 'Match the whole word only.'}, 'document': _DOC, 'morpheme_forms': {'type': 'boolean'},
         'lexicon': {'type': 'boolean'}}, ['pattern', 'replacement']),
    _fn('copy_to_orthography',
        'PLAN: fill an orthography for every word that lacks a value, from the baseline or another orthography.',
        {'orthography': {'type': 'string'}, 'source': {'type': 'string'}, 'document': _DOC,
         'overwrite': {'type': 'boolean'}}, ['orthography']),
    _fn('set_field_for_form',
        'PLAN: set a field value on every occurrence of a form: a morpheme form for a morpheme field, a word form for '
        'a word field (e.g. Gloss (Morpheme) = "OBL" on every morpheme "ди"). only_empty=true (default) fills gaps '
        'and leaves existing values alone; false overwrites them.',
        {'form': {'type': 'string'}, 'field': {'type': 'string'}, 'value': {'type': 'string'},
         'only_empty': {'type': 'boolean'}, 'document': _DOC}, ['form', 'field', 'value']),
    _fn('set_analysis_for_form',
        'PLAN: apply one analysis (same shape as set_analysis\'s morphemes) to every occurrence of a word form; '
        'skip_analyzed=true leaves already-analysed words alone.',
        {'form': {'type': 'string'},
         'morphemes': {'type': 'array', 'items': {'type': 'object', 'properties': {
             'form': {'type': 'string'}, 'type': {'type': 'string'},
             'fields': {'type': 'object', 'additionalProperties': {'type': 'string'}}}, 'required': ['form']}},
         'document': _DOC, 'skip_analyzed': {'type': 'boolean'}}, ['form', 'morphemes']),
    _fn('merge_entries',
        'PLAN: fold one lexicon entry into another (links move to the kept entry, the other is deleted).',
        {'keep_form': {'type': 'string'}, 'remove_form': {'type': 'string'}, 'lexicon': {'type': 'string'},
         'keep_id': {'type': 'string'}, 'remove_id': {'type': 'string'},
         'keep_gloss': _GLOSS, 'remove_gloss': _GLOSS}, []),
    _fn('delete_entry', 'PLAN: delete a lexicon entry and its links; the words and morphemes stay, unlinked.',
        _ENTRY, []),
    _fn('rename_entry', 'PLAN: change a lexicon entry\'s headword form.',
        {'new_form': {'type': 'string'}, **_ENTRY}, ['new_form']),
    _fn('rename_document', 'PLAN: rename a document.',
        {'document': _DOC, 'new_name': {'type': 'string'}}, ['document', 'new_name']),
]
_IMPL.update({
    'corpus_stats': t_corpus_stats, 'frequency_list': t_frequency_list, 'worklist': t_worklist,
    'check_lexicon': t_check_lexicon, 'check_integrity': t_check_integrity, 'sequence_search': t_sequence_search,
    'replace_in_field': t_replace_in_field, 'respell_all': t_respell_all, 'copy_to_orthography': t_copy_to_orthography,
    'set_analysis_for_form': t_set_analysis_for_form, 'set_field_for_form': t_set_field_for_form, 'merge_entries': t_merge_entries, 'delete_entry': t_delete_entry,
    'rename_entry': t_rename_entry, 'rename_document': t_rename_document,
})
TOOLS += [
    _fn('split_word',
        'PLAN: split one word token into two. at: the left part ("Ali") or the number of characters in it. The '
        'word\'s morpheme analysis is deleted (re-analyse both parts after); its values and link stay on the left part.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The word, sN.wN.'},
         'at': {'type': 'string', 'description': 'The left part, or its length.'}}, ['document', 'ref', 'at']),
    _fn('merge_words',
        'PLAN: merge adjacent words of one sentence into one token. Their morpheme analyses are deleted; word '
        'values are combined losslessly (distinct values joined with " | "); one lexicon link is kept.',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('delete_word',
        'PLAN: delete word tokens. The text is unchanged (use respell to change spelling); the words\' analyses, '
        'values, and links go with them.',
        {'document': _DOC, 'refs': _REFS}, ['document', 'refs']),
    _fn('split_sentence',
        'PLAN: split a sentence so that word before_word starts a new sentence. Words and their analyses are '
        'untouched; sentence values (translation) stay with the first part.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The sentence, sN.'},
         'before_word': {'type': 'integer', 'description': 'Number of the word that starts the new sentence (2 or more).'}},
        ['document', 'ref', 'before_word']),
    _fn('merge_sentences',
        'PLAN: merge a sentence into the one before it. Sentence values are combined losslessly.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The later sentence, sN (N ≥ 2).'}},
        ['document', 'ref']),
    _fn('append_text',
        'PLAN: add text at the end of a document, one sentence per line, tokenized into words like the editor.',
        {'document': _DOC, 'text': {'type': 'string'}}, ['document', 'text']),
    _fn('retype_sentence',
        'PLAN: replace the baseline text of one sentence (fix a transcript: insert, remove, or respell words). '
        'Unchanged words keep their analyses; changed text is re-tokenized without analysis; the sentence\'s '
        'own fields stay. Newlines in the new text split it into several sentences.',
        {'document': _DOC, 'ref': {'type': 'string', 'description': 'The sentence, sN.'}, 'text': {'type': 'string'}},
        ['document', 'ref', 'text']),
]
_IMPL.update({'split_word': t_split_word, 'merge_words': t_merge_words, 'delete_word': t_delete_word,
              'split_sentence': t_split_sentence, 'merge_sentences': t_merge_sentences,
              'append_text': t_append_text, 'retype_sentence': t_retype_sentence})
WEB_FENCE_TOP, WEB_FENCE_END, WEB_WARNING = webtools.FENCE_TOP, webtools.FENCE_END, webtools.WARNING



TOOLS += [
    _fn('query_help',
        'The reference for the query language used by `query`, plus the layer names of this project. Call it once '
        'before writing a query; it is long, so only when the other tools cannot express the question.',
        {}, []),
    _fn('query',
        'Run a read-only query in Plaid\'s query language over this project (structure across layers, joins, '
        'negation, aggregates). Name layers by their names from query_help. Prefer the specialised tools when they '
        'fit; this is the escape hatch for questions they cannot express.',
        {'query': {'type': 'object', 'description': 'The query object: find, where, return, limit, order_by.'},
         'limit': limit_arg('query', 'Rows to show')},
        ['query']),
]
_IMPL.update({'query_help': t_query_help, 'query': t_query})

# The project's own annotation manual. Always offered: the titles and
# summaries are in the prompt, and this reads one in full.
TOOLS += _guidelines.schemas('interlinear text: how this project glosses, segments and translates')
_IMPL.update({'read_guideline': t_read_guideline})

# Drafting one is a PLAN, like every other change: the user approves it on the
# card before anything is written.
TOOLS += _guidelines.write_schemas()
_IMPL.update({'add_guideline': t_add_guideline, 'revise_guideline': t_revise_guideline,
              'rewrite_guideline': t_rewrite_guideline})

# Offered only when the operator configured a search backend (see tools_for).
TOOLS += webtools.schemas('this corpus and its lexicons')
_IMPL.update({'web_search': t_web_search, 'read_url': t_read_url})

# Offered only where the user has actually attached a file to the conversation
# (see tools_for). What the code does with one is in core/filetools.py's api().
TOOLS += filetools.schemas()
_IMPL.update({'read_file': t_read_file})

# A tool that plans a change says so in the first word of its description, and
# that is what makes it one: no second list to keep in step with the first.
WRITE_TOOLS = {t['function']['name'] for t in TOOLS if t['function']['description'].startswith('PLAN:')}


def tools_for(ws: Workspace) -> List[Dict[str, Any]]:
    """The tools a turn on this workspace may call."""
    return core_tools_for(ws, TOOLS, WEB_TOOLS, CODE_TOOLS, FILE_TOOLS)


TOOLS += _sandbox.schemas('the texts and lexicons')
_IMPL.update({'run_code': t_run_code, 'code_help': t_code_help})
