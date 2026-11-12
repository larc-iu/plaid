"""End-to-end test of vocab_home_orphans.py against a PRIVATE core running the OLD server (the version before
vocabularies had a home project, master 63fbed244 or a tag built from it), as an operator runs it before upgrading.
Not part of any suite: it needs that core.

It makes, on that core: three users; four vocabularies no project links (one whose only maintainer is a user other
than the token's, one maintained by the token's user and another, one with no maintainer left, and with `--db` one
whose only maintainer's account was deactivated with its row left behind, as older servers left it); one vocabulary
one project links; one two projects link. Then it runs the script's dry run (writes nothing, lists them and the
shared one, counts said in the singular for one), `--apply --only=` one of them, `--apply`, and a second dry run
that must list none, and checks that each got exactly one new project named after it, maintained by its active
maintainers (the token's user only where it was one of them or nobody else was), with its entries untouched.

Run on a FRESH core (the second dry run counts every vocabulary on the server), from plaid-core:

    PYTHONPATH=<old checkout>/plaid-client-py/src <env>/bin/python scripts/test_vocab_home_orphans.py \\
        --url http://127.0.0.1:8812 --token-file <admin named token file> --session-token-file <admin login token file> \\
        [--db <that core's database file>]

Exit code 0 when every check passed.
"""
import argparse
import os
import subprocess
import sys
import uuid
from pathlib import Path

from plaid_client import PlaidClient

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'vocab_home_orphans.py')
sys.path.insert(0, HERE)
import vocab_home_orphans as orphans_script  # noqa: E402

failures = []


def check(cond, what):
    print(('ok    ' if cond else 'FAIL  ') + what)
    if not cond:
        failures.append(what)


def run(url, token_file, *args):
    r = subprocess.run([sys.executable, SCRIPT, url, token_file, *args], capture_output=True, text=True,
                       env=dict(os.environ))
    if r.returncode != 0:
        print(r.stdout, r.stderr)
    return r.returncode, r.stdout


def linking(c, vid):
    return [p for p in c.projects.list() if any(v['id'] == vid for v in c.projects.get(p['id']).get('vocabs') or [])]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', required=True)
    ap.add_argument('--token-file', required=True, help='an admin\'s named API token, as an operator runs the script with')
    ap.add_argument('--session-token-file', required=True,
                    help='an admin\'s login token, for making the test\'s users (a named token may not)')
    ap.add_argument('--db', help='the core\'s database file, to leave a deactivated maintainer\'s row behind')
    a = ap.parse_args()
    if not any(h in a.url for h in ('127.0.0.1', 'localhost')):
        sys.exit('The core must be a private one, on localhost.')
    token = Path(a.token_file).read_text().strip()
    c = PlaidClient(a.url, token)
    me = orphans_script.token_user(token)
    tag = uuid.uuid4().hex[:6]
    u1, u2, u3 = f'orph-a-{tag}@example.com', f'orph-b-{tag}@example.com', f'orph-c-{tag}@example.com'
    session = PlaidClient(a.url, Path(a.session_token_file).read_text().strip())
    for u in (u1, u2, u3):
        session.users.create(u, 'a-long-password-1', False)

    def vocab(name, maintainers, forms):
        vid = c.vocab_layers.create(name)['id']  # the old server makes the token's user a maintainer
        for m in maintainers:
            if m != me:
                c._request('POST', f'/api/v1/vocab-layers/{vid}/maintainers/{m}')
        if me not in maintainers:
            c._request('DELETE', f'/api/v1/vocab-layers/{vid}/maintainers/{me}')
        for f in forms:
            c.vocab_items.create(vid, f)
        return vid

    o1 = vocab(f'Lexicon one {tag}', [u1], ['kai', 'kaj'])
    o2 = vocab(f'Lexicon two {tag}', [me, u2], ['kak'])
    o3 = vocab(f'Lexicon three {tag}', [], ['kal', 'kam', 'kan'])
    o4 = None
    if a.db:
        # Deactivating removes the account's vocabulary maintainer rows. Older servers left them, so the row is
        # put back by hand, as the reviewer found it (REV-VH-A S5).
        import sqlite3
        o4 = vocab(f'Lexicon four {tag}', [], ['kao'])
        session.users.delete(u3)
        db = sqlite3.connect(a.db, timeout=10)
        db.execute('INSERT INTO vocab_maintainers (vocab_layer_id, user_id) VALUES (?, ?)', (o4, u3))
        db.commit()
        db.close()
    orphans = [o for o in (o1, o2, o3, o4) if o]
    p = c.projects.create(f'P {tag}')['id']
    q = c.projects.create(f'Q {tag}')['id']
    linked = vocab(f'Linked {tag}', [me], ['x'])
    c.projects.link_vocab(p, linked)
    shared = vocab(f'Shared {tag}', [me], ['y'])
    c.projects.link_vocab(p, shared)
    c.projects.link_vocab(q, shared)
    projects_before = len(c.projects.list())

    code, out = run(a.url, a.token_file)
    check(code == 0, 'the dry run exits 0')
    check(f'Vocabularies no project links: {len(orphans)}' in out, 'the dry run lists each vocabulary no project links')
    for vid, said in ((o1, '2 entries, 1 maintainer'), (o2, '1 entry, 2 maintainers'), (o3, '3 entries, 0 maintainers')):
        check(f'({vid}): {said}' in out, f'the dry run names {vid}: {said}')
    if o4:
        check(f'({o4}): 1 entry, 1 maintainer, 1 of them deactivated' in out, 'the dry run counts the deactivated one')
    check(f'"Shared {tag}" ({shared}): "P {tag}", "Q {tag}"' in out, 'the dry run lists the shared vocabulary')
    check(len(c.projects.list()) == projects_before, 'the dry run wrote nothing')

    code, out = run(a.url, a.token_file, '--apply', f'--only={o1}')
    check(code == 0, '--only exits 0')
    check('Gave 1 vocabulary a project.' in out, 'one vocabulary is said in the singular')
    check(len(linking(c, o1)) == 1 and not linking(c, o2) and not linking(c, o3), '--only gave only that one a project')

    code, out = run(a.url, a.token_file, '--apply')
    check(code == 0, '--apply exits 0')
    check(f'Gave {len(orphans) - 1} vocabularies a project.' in out, 'the rest are counted')
    if o4:
        check(f'({o4}): project' in out and f'no maintainer but {me} (its maintainers are deactivated)' in out,
              'a vocabulary whose maintainers are all deactivated is said to have none but the token\'s user')
        ps = linking(c, o4)
        check(len(ps) == 1 and set(c.projects.get(ps[0]['id']).get('maintainers') or []) == {me},
              'the deactivated account is not made a maintainer')
    code, out = run(a.url, a.token_file)
    check('Vocabularies no project links: 0' in out, 'a second dry run lists none')

    for vid, name, want in ((o1, f'Lexicon one {tag}', {u1}), (o2, f'Lexicon two {tag}', {me, u2}),
                            (o3, f'Lexicon three {tag}', {me})):
        ps = linking(c, vid)
        check(len(ps) == 1 and ps[0]['name'] == name, f'{name} is linked by one project named after it')
        if ps:
            full = c.projects.get(ps[0]['id'])
            check(set(full.get('maintainers') or []) == want, f'{name}: its maintainers maintain the project')
            check(not (full.get('writers') or []) and not (full.get('readers') or []), f'{name}: nobody else')
    check([i['form'] for i in c.vocab_layers.get(o3, include_items=True)['items']] == ['kal', 'kam', 'kan'],
          'entries are untouched')
    check(len(linking(c, linked)) == 1 and len(linking(c, shared)) == 2, 'linked vocabularies are untouched')

    code, out = run(a.url, a.token_file, '--apply', '--only=00000000-0000-0000-0000-000000000000')
    check(code == 2, '--only naming a vocabulary that is not one of them refuses')

    print(f'\n{len(failures)} failed' if failures else '\nall passed')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
