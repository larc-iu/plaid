"""Give every vocabulary that no project links a project of its own, before the upgrade that gives each
vocabulary a home project (2026-11-12).

The new version refuses to start while such a vocabulary exists: its migration names each one and this script.
Run this against the server BEFORE the upgrade, while it still runs the old version, with an admin's API token
in a file. It needs Python 3.11 with requests, and the Plaid Python client (plaid-client-py in this repository, on
PYTHONPATH, or the larc-plaid-client package), of any version. From the top of a checkout of the repository:

    PYTHONPATH=plaid-client-py/src python3 plaid-core/scripts/vocab_home_orphans.py BASE_URL TOKEN_FILE   # dry run
    PYTHONPATH=plaid-client-py/src python3 plaid-core/scripts/vocab_home_orphans.py BASE_URL TOKEN_FILE --apply
    PYTHONPATH=plaid-client-py/src python3 plaid-core/scripts/vocab_home_orphans.py BASE_URL TOKEN_FILE --apply \
        --only=<vocab id>,<vocab id>

The dry run lists every vocabulary no project links (name, id, entries, how many maintainers, and how many of
them are deactivated) and every vocabulary several projects link (name, the linking projects' names: the upgrade
picks one of them as its home and logs why).

--apply, for each vocabulary no project links (nothing is deleted, each gets its own project): create a project
named after the vocabulary, make each of the vocabulary's maintainers a maintainer of it, link the vocabulary to
it (the upgrade then makes it the home), and take the token's own user off the new project unless they are one of
the vocabulary's maintainers or no one else would maintain it. A deactivated account is not made a maintainer: a
vocabulary whose maintainers are all deactivated gets a project maintained only by the token's user, and the
script says so. A second dry run must list none.

Uses only routes the old and the new client both have.
"""
import base64
import json
import sys
from pathlib import Path

from plaid_client import PlaidClient


def token_user(token):
    payload = token.split('.')[1]
    payload += '=' * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))['user/id']


def count(n, one, many):
    return f'{n} {one if n == 1 else many}'


def census(c):
    """(vocabularies no project links, vocabularies several link, project names), read only."""
    projects = c.projects.list()
    linked = {}
    for p in projects:
        for v in c.projects.get(p['id']).get('vocabs') or []:
            linked.setdefault(v['id'], []).append(p['id'])
    names = {p['id']: p['name'] for p in projects}
    vocabs = c.vocab_layers.list()
    orphans = [v for v in vocabs if v['id'] not in linked]
    shared = [(v, linked[v['id']]) for v in vocabs if len(linked.get(v['id'], [])) > 1]
    return orphans, shared, names


def entries(c, vid):
    return len(c.vocab_layers.get(vid, include_items=True).get('items') or [])


def deactivated(c, uid):
    """Is account `uid` deactivated? A user record carries `deactivated-at`, null while active."""
    u = c.users.get(uid) or {}
    return bool(u.get('deactivated-at') or u.get('deactivated_at'))


def maintainers_of(c, v):
    """(active maintainers, deactivated maintainers) of vocabulary `v`."""
    every = list(v.get('maintainers') or [])
    gone = [uid for uid in every if deactivated(c, uid)]
    return [uid for uid in every if uid not in gone], gone


def give_project(c, v, me, active):
    """A new project named after `v`, its active maintainers maintaining it, linking it. Returns the project
    id."""
    pid = c.projects.create(v['name'])['id']
    for uid in active:
        if uid != me:
            c.projects.add_maintainer(pid, uid)
    c.projects.link_vocab(pid, v['id'])
    if active and me not in active:
        c.projects.remove_maintainer(pid, me)
    return pid


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    base, token_file = argv[1].rstrip('/'), argv[2]
    apply = '--apply' in argv[3:]
    only = None
    for a in argv[3:]:
        if a.startswith('--only='):
            only = {x.strip() for x in a[len('--only='):].split(',') if x.strip()}
        elif a != '--apply':
            print(f'Unknown argument: {a}')
            return 2
    token = Path(token_file).read_text().strip()
    c = PlaidClient(base, token)
    me = token_user(token)
    orphans, shared, names = census(c)
    if only is not None:
        unknown = only - {v['id'] for v in orphans}
        if unknown:
            print(f'Not a vocabulary no project links: {", ".join(sorted(unknown))}')
            return 2
        orphans = [v for v in orphans if v['id'] in only]
    people = {v['id']: maintainers_of(c, v) for v in orphans}

    print(f'Vocabularies no project links: {len(orphans)}')
    for v in orphans:
        active, gone = people[v['id']]
        print(f'  "{v["name"]}" ({v["id"]}): {count(entries(c, v["id"]), "entry", "entries")}, '
              f'{count(len(active) + len(gone), "maintainer", "maintainers")}'
              + (f', {len(gone)} of them deactivated' if gone else ''))
    print(f'Vocabularies several projects link: {len(shared)}')
    for v, pids in shared:
        print(f'  "{v["name"]}" ({v["id"]}): ' + ', '.join(f'"{names.get(p, p)}"' for p in pids))

    if not apply:
        if orphans:
            print('Dry run: nothing written. Run again with --apply to give each its own project.')
        return 0
    for v in orphans:
        active, gone = people[v['id']]
        pid = give_project(c, v, me, active)
        said = (f'{count(len(active), "maintainer", "maintainers")}' if active
                else f'no maintainer but {me}' + (' (its maintainers are deactivated)' if gone else ''))
        print(f'  "{v["name"]}" ({v["id"]}): project {pid} made, {said}, linked')
    print(f'Gave {count(len(orphans), "vocabulary", "vocabularies")} a project. '
          f'Run the dry run again: it must list none.')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
