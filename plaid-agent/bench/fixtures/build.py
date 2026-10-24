"""Build the benchmark's starting database from the public sources in src/.

    build.sh            (runs this with $PLAID_AGENT_PYTHON)

1. A fresh core (the jar in code/CURRENT) on an empty database under
   fixtures/build/, admin A = a@b.com.
2. Users B and C (writers) and reader@x.com, a named API token each for A, B, C.
3. igt: SIGMORPHON 2023 Lezgi, Natugu and Gitksan (dev, track 2) through
   sigmorphon_to_cldf.py (with a lexicon of every morpheme form, unlinked) and
   plaid-igt's own CLDF import.
4. ud: the first 60 dev sentences of UD French-GSD, Russian-GSD and
   Arabic-PADT (r2.18), three documents each, through plaid-ud's own
   project setup and CoNLL-U import.
5. umr: Kukama text 2 of UMR 2.0, its interlinear lines as an igt project
   (umr_to_cldf.py, the CLDF import), then adopted for UMR and its graphs
   attached onto that document (plaid-umr's adoptSubstrate and importUmrDocument).
6. B and C become writers on every project and maintainers of every vocabulary.
7. Every document is saved as baseline/<id>.json (the read the checkers diff
   against), the core is stopped, and the database directory is copied to
   snapshot/ with manifest.json (project and document ids, tokens, versions).

The JS importers run from the checkout's working tree (copied into
plaid-<app>/out/bench/, which git ignores, and removed afterwards). The
commit is recorded in the manifest.
"""
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'lib'))
import benchlib as bl  # noqa: E402

HERE = Path(__file__).resolve().parent
SRC = bl.FIXTURES / 'src'
WORK = bl.FIXTURES / 'build'
REPO = Path(os.environ.get('PLAID_REPO') or Path(__file__).resolve().parents[3])
# A python with pycldf, for the CLDF converters: $PLAID_BENCH_CLDF_PYTHON, else this one.
BASE_PY = os.environ.get('PLAID_BENCH_CLDF_PYTHON') or sys.executable
NODE = os.environ.get('PLAID_NODE') or shutil.which('node') or 'node'

IGT = [
    ('igt-lezgi', 'Lezgi (SIGMORPHON 2023)', 'sigmorphon2023/Lezgi/lez-dev-track2-uncovered', 'lezg1247', 'Lezgi'),
    ('igt-natugu', 'Natugu (SIGMORPHON 2023)', 'sigmorphon2023/Natugu/ntu-dev-track2-uncovered', 'natu1246', 'Natugu'),
    ('igt-gitksan', 'Gitksan (SIGMORPHON 2023)', 'sigmorphon2023/Gitksan/git-dev-track2-uncovered', 'gitx1241', 'Gitksan'),
]
UD = [
    ('ud-french', 'French GSD (UD 2.18)', 'ud-r2.18/UD_French-GSD/fr_gsd-ud-dev.conllu', 'French'),
    ('ud-russian', 'Russian GSD (UD 2.18)', 'ud-r2.18/UD_Russian-GSD/ru_gsd-ud-dev.conllu', 'Russian'),
    ('ud-arabic', 'Arabic PADT (UD 2.18)', 'ud-r2.18/UD_Arabic-PADT/ar_padt-ud-dev.conllu', 'Arabic'),
]
UMR = ('umr-kukama', 'Kukama (UMR 2.0)', 'umr2.0/kukama/umr_data/kukama_umr-0002.umr', 'kuka1246', 'Kukama',
       'Kukama text 2')


def run(cmd, cwd=None, capture=True):
    print('  $', ' '.join('<token>' if str(c).startswith('eyJ') else Path(str(c)).name if '/' in str(c) else str(c) for c in cmd), flush=True)
    r = subprocess.run([str(c) for c in cmd], cwd=cwd, capture_output=True, text=True)
    if r.stderr.strip():
        for line in r.stderr.strip().splitlines()[-8:]:
            print('    ' + line)
    if r.returncode:
        raise SystemExit(f'failed ({r.returncode}): {r.stdout[-2000:]}')
    return r.stdout


def last_json(out):
    return json.loads([ln for ln in out.splitlines() if ln.startswith('{')][-1])


def main():
    code = bl.use_code()
    from plaid_client import PlaidClient

    if WORK.exists():
        shutil.rmtree(WORK)
    (WORK / 'db').mkdir(parents=True)
    (WORK / 'data').mkdir()
    core = bl.Core(code, WORK / 'db', WORK / 'core.log').start()
    print(f'core at {core.url}')
    copied = []
    try:
        a = PlaidClient.login(core.url, *bl.USERS['A'])
        for key in ('B', 'C'):
            a.users.create(bl.USERS[key][0], bl.USERS[key][1], False)
        a.users.create('reader@x.com', 'reader-pass-1', False)
        tokens = {}
        for key, (uid, pw) in bl.USERS.items():
            c = PlaidClient.login(core.url, uid, pw)
            tokens[key] = c.api_tokens.create(uid, 'bench')['token']
        ta = tokens['A']

        # JS importers, run from the working tree's app packages.
        for app, script in (('igt', 'igt_import.mjs'), ('ud', 'ud_import.mjs'), ('umr', 'umr_attach.mjs')):
            d = REPO / f'plaid-{app}/out/bench'
            d.mkdir(parents=True, exist_ok=True)
            shutil.copy(HERE / script, d / script)
            copied.append(d)

        projects = {}
        for key, name, src, glotto, lang in IGT:
            z = WORK / 'data' / f'{key}.zip'
            run([BASE_PY, HERE / 'sigmorphon_to_cldf.py', SRC / src, z, '--glottocode', glotto, '--name', lang, '--lexicon'])
            out = last_json(run([NODE, '--import', './e2e/live/aliases.mjs', 'out/bench/igt_import.mjs',
                                 core.url, ta, z, name], cwd=REPO / 'plaid-igt'))
            projects[key] = {'app': 'igt', 'id': out['projectId'], 'name': name, 'source': src,
                             'documents': out['documents'], 'stats': out['stats']}
            print(f'{key}: {out["stats"]}')

        for key, name, src, lang in UD:
            prefix = key.split('-')[1]
            run([BASE_PY, HERE / 'conllu_slice.py', SRC / src, WORK / 'data', prefix, '--sentences', '60',
                 '--docs', '3'])
            pairs = [f'{lang} {k}={WORK / "data" / f"{prefix}-{k}.conllu"}' for k in (1, 2, 3)]
            out = last_json(run([NODE, 'out/bench/ud_import.mjs', core.url, ta, name, *pairs],
                                cwd=REPO / 'plaid-ud'))
            projects[key] = {'app': 'ud', 'id': out['projectId'], 'name': name, 'source': src,
                             'documents': out['documents'], 'warnings': out['warnings']}
            print(f'{key}: {len(out["documents"])} documents')

        key, name, src, glotto, lang, text = UMR
        z = WORK / 'data' / f'{key}.zip'
        run([BASE_PY, HERE / 'umr_to_cldf.py', SRC / src, z, '--glottocode', glotto, '--name', lang, '--text', text])
        out = last_json(run([NODE, '--import', './e2e/live/aliases.mjs', 'out/bench/igt_import.mjs',
                             core.url, ta, z, name], cwd=REPO / 'plaid-igt'))
        doc = out['documents'][0]
        att = last_json(run([NODE, 'out/bench/umr_attach.mjs', core.url, ta, out['projectId'], doc['id'], SRC / src],
                            cwd=REPO / 'plaid-umr'))
        projects[key] = {'app': 'umr', 'also': ['igt'], 'id': out['projectId'], 'name': name, 'source': src,
                         'documents': out['documents'], 'stats': out['stats'], 'umr_warnings': att['warnings']}
        print(f'{key}: attached={att["attached"]}')

        # Members, vocabularies, baselines.
        (WORK / 'baseline').mkdir()
        for key, p in projects.items():
            for u in ('B', 'C'):
                a.projects.add_writer(p['id'], bl.USERS[u][0])
            proj = a.projects.get(p['id'])
            p['vocabs'] = []
            for v in proj.get('vocabs') or []:
                for u in ('B', 'C'):
                    a.vocab_layers.add_maintainer(v['id'], bl.USERS[u][0])
                p['vocabs'].append({'id': v['id'], 'name': v.get('name')})
            for d in p['documents']:
                body = a.documents.get(d['id'], include_body=True)
                (WORK / 'baseline' / f'{d["id"]}.json').write_text(json.dumps(body, ensure_ascii=False))
    finally:
        core.stop()
        for d in copied:
            shutil.rmtree(d, ignore_errors=True)

    if bl.SNAPSHOT.exists():
        shutil.rmtree(bl.SNAPSHOT)
    bl.copy_db(WORK / 'db', bl.SNAPSHOT)
    shutil.copytree(WORK / 'baseline', bl.SNAPSHOT / 'baseline')
    commit = subprocess.run(['git', '-C', str(REPO), 'rev-parse', '--short=9', 'HEAD'], capture_output=True,
                            text=True).stdout.strip()
    dirty = bool(subprocess.run(['git', '-C', str(REPO), 'status', '--porcelain', '--', 'plaid-igt', 'plaid-ud',
                                 'plaid-umr', 'plaid-ui'], capture_output=True, text=True).stdout.strip())
    man = {
        'built_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'core_code': code.name,
        'importers_commit': commit + ('+dirty' if dirty else ''),
        'users': {k: v[0] for k, v in bl.USERS.items()},
        'tokens': tokens,
        'projects': projects,
    }
    (bl.SNAPSHOT / 'manifest.json').write_text(json.dumps(man, indent=1, ensure_ascii=False))
    print(f'snapshot: {bl.SNAPSHOT}')


if __name__ == '__main__':
    main()
