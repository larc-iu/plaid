import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { UserAvatar } from '@/components/shared/UserAvatar';
import { timeAgo, fullTimestamp } from '@/utils/formatTime';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { useConfirm } from '@/components/shared/ConfirmProvider';
import { AuditEntries } from './AuditEntries';

// One account: what they can reach, what they have been doing, and what is
// holding a session open in their name.

export const UserDetail = ({ client, userId, onBack, onEdit, dialogs }) => {
  const confirm = useConfirm();
  const [user, setUser] = useState(null);
  const [projects, setProjects] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [audit, setAudit] = useState([]);
  const [tally, setTally] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [u, projectPage, tokenList, auditPage, tallyRows] = await Promise.all([
        client.users.get(userId),
        client.projects.listPage({ limit: 1000 }),
        client.apiTokens.list(userId).catch(() => []),
        client.audit.listPage({ limit: 50 }).catch(() => ({ entries: [] })),
        client.audit.tally().catch(() => []),
      ]);
      setUser(u);
      setProjects(
        (projectPage.entries || [])
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
      // The instance feed filtered here rather than asked for per user: the
      // per-user endpoint returns their whole history, and this panel wants
      // the recent end of it.
      setAudit((auditPage.entries || []).filter((e) => e.user?.id === userId).slice(0, 25));
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

          <section className="rounded-md border">
            <h3 className="border-b px-3 py-2 text-sm font-semibold">Projects</h3>
            {projects.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">No project roles.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {projects.map((p) => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="px-3 py-2">
                        <Link to={`/projects/${p.id}`} className="hover:underline">
                          {p.name}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{p.role}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="rounded-md border">
            <h3 className="border-b px-3 py-2 text-sm font-semibold">API tokens</h3>
            {tokens.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">No tokens.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {tokens.map((t) => (
                    <tr key={t.id} className="border-b last:border-0">
                      <td className="px-3 py-2">{t.name}</td>
                      <td
                        className="px-3 py-2 text-muted-foreground"
                        title={fullTimestamp(t.createdAt)}
                      >
                        Created {timeAgo(t.createdAt)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button size="sm" variant="ghost" onClick={() => revokeToken(t)}>
                          Revoke
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="rounded-md border">
            <h3 className="border-b px-3 py-2 text-sm font-semibold">Recent activity</h3>
            <AuditEntries entries={audit} empty="Nothing recent." />
          </section>
        </>
      )}
      {dialogs}
    </div>
  );
};
