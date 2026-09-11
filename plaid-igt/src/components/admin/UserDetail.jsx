import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Badge } from '@ui/components/ui/badge';
import { UserAvatar } from '@ui/components/shared/UserAvatar';
import { DataTable } from '@ui/components/ui/data-table';
import { timeAgo, fullTimestamp } from '@ui/utils/formatTime';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { AuditFeed } from '@ui/components/shared/AuditFeed';

// One account: what they can reach, what they have been doing, and what is
// holding a session open in their name.

export const UserDetail = ({ client, userId, onBack, onEdit, dialogs }) => {
  const confirm = useConfirm();
  const [user, setUser] = useState(null);
  const [projects, setProjects] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [tally, setTally] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [u, projectList, tokenList, tallyRows] = await Promise.all([
        client.users.get(userId),
        client.projects.list(),
        client.apiTokens.list(userId).catch(() => []),
        client.audit.tally().catch(() => []),
      ]);
      setUser(u);
      setProjects(
        (projectList || [])
          .map((p) => ({
            id: p.id,
            name: p.name,
            role: p.maintainers?.includes(userId)
              ? 'Maintainer'
              : p.writers?.includes(userId)
                ? 'Writer'
                : p.readers?.includes(userId)
                  ? 'Reader'
                  : null,
          }))
          .filter((p) => p.role),
      );
      setTokens(tokenList || []);
      setTally((tallyRows || []).find((r) => r.user?.id === userId) || null);
    } catch (err) {
      console.error('Error loading user:', err);
      notifyError(err.message || 'Failed to load the account', 'Error');
    } finally {
      setLoading(false);
    }
  }, [client, userId]);

  useEffect(() => {
    load();
  }, [load]);

  const revokeToken = async (token) => {
    const ok = await confirm({
      title: 'Revoke this token?',
      description: `Anything using "${token.name}" stops working immediately.`,
      confirmLabel: 'Revoke',
      destructive: true,
    });
    if (!ok) return;
    try {
      await client.apiTokens.revoke(userId, token.id);
      setTokens((ts) => ts.filter((t) => t.id !== token.id));
      notifySuccess('Token revoked', 'Revoked');
    } catch (err) {
      notifyError(err.message || 'Failed to revoke the token', 'Error');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" /> All accounts
      </Button>

      {loading && !user ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !user ? null : (
        <>
          <div className="flex items-center gap-3">
            <UserAvatar
              client={client}
              userId={user.id}
              displayName={user.displayName}
              avatarHash={user.avatarHash}
              className="h-12 w-12"
            />
            <div>
              <h2 className="flex items-center gap-2 text-xl font-semibold">
                {user.displayName || user.id}
                {user.isAdmin && <Badge variant="secondary">Admin</Badge>}
                {user.deactivatedAt && <Badge variant="outline">Deactivated</Badge>}
              </h2>
              <p className="text-sm text-muted-foreground">{user.id}</p>
            </div>
            <Button variant="outline" size="sm" className="ml-auto" onClick={() => onEdit(user)}>
              Edit
            </Button>
          </div>

          {tally && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Changes', tally.changes.toLocaleString()],
                ['Documents', tally.documents.toLocaleString()],
                ['First', timeAgo(tally.firstTs)],
                ['Last', timeAgo(tally.lastTs)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div className="text-lg font-semibold tabular-nums">{value}</div>
                </div>
              ))}
            </div>
          )}

          <DataTable
            title="Projects"
            rows={projects}
            columns={[
              {
                key: 'name',
                label: 'Project',
                sort: (p) => p.name.toLowerCase(),
                render: (p) => (
                  <Link to={`/projects/${p.id}`} className="hover:underline">
                    {p.name}
                  </Link>
                ),
              },
              {
                key: 'role',
                label: 'Role',
                sort: (p) => p.role,
                align: 'right',
                className: 'text-muted-foreground',
                render: (p) => p.role,
              },
            ]}
            rowKey={(p) => p.id}
            id="user-projects"
            defaultSort={{ key: 'name', dir: 'asc' }}
            search={{
              placeholder: 'Search projects…',
              match: (p, q) => p.name.toLowerCase().includes(q),
            }}
            noun="project"
            empty="No project roles."
          />

          <DataTable
            title="API tokens"
            rows={tokens}
            columns={[
              {
                key: 'name',
                label: 'Name',
                sort: (t) => (t.name || '').toLowerCase(),
                render: (t) => t.name,
              },
              {
                key: 'created',
                label: 'Created',
                sort: (t) => (t.createdAt ? new Date(t.createdAt).getTime() : null),
                className: 'text-muted-foreground',
                render: (t) => (
                  <span title={fullTimestamp(t.createdAt)}>{timeAgo(t.createdAt)}</span>
                ),
              },
              {
                key: 'actions',
                label: '',
                headerClassName: 'w-24',
                align: 'right',
                render: (t) => (
                  <Button size="sm" variant="ghost" onClick={() => revokeToken(t)}>
                    Revoke
                  </Button>
                ),
              },
            ]}
            rowKey={(t) => t.id}
            id="user-tokens"
            defaultSort={{ key: 'created', dir: 'desc' }}
            noun="token"
            empty="No tokens."
          />

          <AuditFeed
            title="Recent activity"
            id="user-activity"
            resetKey={userId}
            empty="Nothing recorded."
            fetchPage={({ limit, cursor }) =>
              client.users.auditPage(userId, { limit, cursor, order: 'desc' })
            }
          />
        </>
      )}
      {dialogs}
    </div>
  );
};
