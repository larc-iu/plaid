import igt_job_hand as H
import igtlib as L

DOC = 'Gitksan text 1'
WORD = 's20.w5'
FORM = 'guxw'
OTHER = 'wila'


def setup(ctx):
    """guxw (s20.w5) unanalysed, and a job over Gitksan text 1, started by the
    task's user and ended with a report that lists it under "Left blank" and
    wila under "Forms left inconsistent", as the worker writes a report
    (CONTRACT 5.3 and its "Added by" sections)."""
    L.strip_analysis(ctx, DOC, WORD)
    job = H.start(ctx, [DOC])
    d = L.raw(ctx, DOC)
    ids = L.ids_by_address(d)
    tl = d['text_layers'][0]
    body = tl['text']['body']
    word = next(t for t in L.c._layer(tl, 'word')['tokens'] if t['id'] == ids[WORD])
    assert body[word['begin']:word['end']] == FORM, body[word['begin']:word['end']]
    assert not L.morphemes_of(d, WORD), 'the word is unanalysed'
    doc_id = L.doc_of(ctx, DOC)['id']
    made = ctx.user.jobs.get(job)
    report = {
        'state': 'done', 'reason': None, 'instructions': made['instructions'], 'started_by': made['started_by'],
        'model': 'openai/m', 'started_at': made['started_at'], 'finished_at': None,
        'paused_for_people_s': 0, 'paused_for_model_s': 0, 'stopped': None,
        'totals': {'documents_done': 1, 'documents_in_use': 0, 'documents_gone': 0, 'documents_not_reached': 0,
                   'sentences': 0, 'translations': 0, 'refreshed': 0, 'words': 0, 'links': 0, 'entries': 0,
                   'skipped_too_long': 0, 'skipped_failed': 0, 'skipped_changed': 0, 'skipped_more': 0,
                   'changed': 0, 'proposed': 0},
        'documents': [{'document_id': doc_id, 'name': DOC, 'state': 'done', 'sentences': 20, 'targets': 1,
                       'done': 1, 'counts': {'left': 1}, 'skipped': [], 'gloss_group': None,
                       'harmonize_group': None,
                       'left': [{'ref': WORD, 'sentence_id': ids['s20'], 'begin': word['begin'], 'form': FORM}],
                       'left_more': 0}],
        'harmonize': {'changed': [], 'changed_more': 0, 'left_more': 0,
                      'left': [{'form': OTHER, 'reason': 'no-clear-majority',
                                'analyses': [{'analysis': 'wila ‘MANR’', 'count': 3},
                                             {'analysis': 'wila ‘like’', 'count': 2}]}]},
        'entries': {'created': [], 'deleted': [], 'unlinked': [], 'created_more': 0, 'deleted_more': 0,
                    'unlinked_more': 0, 'lexicons': []},
        'summary': None, 'summary_failed': False, 'plan': None, 'proposed': [], 'proposed_more': 0,
        'proposed_dropped': 0, 'notes': [], 'notes_more': 0, 'tables': [],
    }
    ctx.client.jobs.finish(job, H.WORKER, 'done', report)
    held = ctx.user.jobs.get(job)
    assert held['state'] == 'done' and held['report']['documents'][0]['left'][0]['form'] == FORM
    L.snap(ctx)
