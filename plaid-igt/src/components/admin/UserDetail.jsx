import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { UserAvatar } from '@/components/shared/UserAvatar';
import { SearchInput, ListCount, ListPager } from '@/components/ui/list-search';
import { usePagedList } from '@/hooks/usePagedList';
import { timeAgo, fullTimestamp } from '@/utils/formatTime';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { useConfirm } from '@/components/shared/ConfirmProvider';
import { AuditFeed } from './AuditFeed';

// One account: what they can reach, what they have been doing, and what is
// holding a session open in their name.

export const UserDetail = ({ client, userId, onBack, onEdit, dialogs }) => {
  const confirm = useConfirm();
  const [user, setUser] = useState(null);
  const [projects, setProjects] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [tally, setTally] = useState(null);
  const [loading, setLoading] = useState(true);
  const [projectSearch, setProjectSearch] = useState('');

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

  const shownProjects = useMemo(() => {
    const q = projectSearch.trim().toLowerCase();
    return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;
  }, [projects, projectSearch]);

  const pagedProjects = usePagedList(shownProjects, { resetKey: projectSearch });
  const pagedTokens = usePagedList(tokens, { resetKey: userId });

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
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <h3 className="text-sm font-semibold">Projects</h3>
              <SearchInput
                value={projectSearch}
                onChange={setProjectSearch}
                placeholder="Search projects…"
                className="ml-auto max-w-[14rem]"
              />
              <ListCount shown={shownProjects.length} total={projects.length} noun="project" />
            </div>
            <ListPager {...pagedProjects} onPage={pagedProjects.setPage} position="top" />
            {shownProjects.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">
                {projects.length === 0 ? 'No project roles.' : 'No projects match.'}
              </p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {pagedProjects.pageItems.map((p) => (
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
            <ListPager {...pagedProjects} onPage={pagedProjects.setPage} position="bottom" />
          </section>

          <section className="rounded-md border">
            <h3 className="border-b px-3 py-2 text-sm font-semibold">API tokens</h3>
            <ListPager {...pagedTokens} onPage={pagedTokens.setPage} position="top" />
            {tokens.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">No tokens.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {pagedTokens.pageItems.map((t) => (
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
            <ListPager {...pagedTokens} onPage={pagedTokens.setPage} position="bottom" />
          </section>

          <section className="rounded-md border">
            <h3 className="border-b px-3 py-2 text-sm font-semibold">Recent activity</h3>
            <AuditFeed
              resetKey={userId}
              empty="Nothing recorded."
              fetchPage={({ limit, cursor }) =>
                client.users.auditPage(userId, { limit, cursor, order: 'desc' })
              }
            />
          </section>
        </>
      )}
      {dialogs}
    </div>
  );
};
