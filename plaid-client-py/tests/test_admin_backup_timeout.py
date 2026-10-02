"""A manual backup answers only once the zip is written, minutes on a large
database. Under the usual timeout the page reported a failure while the backup
went on (H7-CORE-OPS-2), so the call waits longer. Mirrors the JS
``adminBackupTimeout.test.js``."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.client import PlaidClient, BACKUP_TIMEOUT_S  # noqa: E402


def test_admin_backup_waits_past_the_usual_timeout():
    client = PlaidClient('http://plaid.test', 't')
    seen = []
    client._request = lambda method, path, **kw: seen.append((method, path, kw)) or {'ok': True}
    client.admin.backup()
    assert [(m, p) for m, p, _ in seen] == [('POST', '/api/v1/admin/backup')]
    assert seen[0][2]['timeout'] == BACKUP_TIMEOUT_S
    assert BACKUP_TIMEOUT_S >= 10 * 60
    assert BACKUP_TIMEOUT_S > (client.timeout or 0)
