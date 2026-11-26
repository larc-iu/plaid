import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Badge } from '@ui/components/ui/badge';
import { UserAvatar } from '@ui/components/shared/UserAvatar';
import { DataTable } from '@ui/components/shared/data-table';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { timeAgo, fullTimestamp } from '@ui/lib/formatTime.js';
import { notifySuccess, notifyError, humanizeError } from '@/utils/feedback';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { AuditFeed } from '@ui/components/shared/AuditFeed';
import { compareNames, textIncludes } from '@ui/domain/collation.js';
import { projectRole } from '@larc-iu/plaid-client';
import { useLatestCall } from '@ui/hooks/useLatestCall.js';
import { TYPE } from '@ui/lib/typeScale.js';
import { cn } from '@ui/lib/utils';
import { ProjectLink } from './ProjectLink';
import { documentTarget, projectTarget } from './projectTarget';
import { t } from '@ui/lib/i18n.js';

// One account: what they can reach, what they have been doing, and what is
// holding a session open in their name.

export const UserDetail = ({ client, userId, backTo, onEdit, dialogs }) => {
  const confirm = useConfirm();
  const [user, setUser] = useState(null);
  const [projects, setProjects] = useState([]);
  // Every project, by id, for where the feed's links lead.
  const [projectsById, setProjectsById] = useState(new Map());
  const [tokens, setTokens] = useState([]);
  const [tally, setTally] = useState(null);
  const [loading, setLoading] = useState(true);
  // An address naming no account, opened from a pasted or stale link.
  const [missing, setMissing] = useState(false);

  const begin = useLatestCall();
  const load = useCallback(async () => {
    // One screen serves every account: the reader opens another from the list
    // and this one stays mounted, so the slower account can answer last.
    const isCurrent = begin();
    setLoading(true);
    setMissing(false);
    try {
      const [u, projectList, tokenList, tallyRows] = await Promise.all([
        client.users.get(userId),
        client.projects.list(),
        client.apiTokens.list(userId).catch(() => []),
        client.audit.tally({ userId }).catch(() => []),
      ]);
      if (!isCurrent()) return;
      setUser(u);
      setProjectsById(new Map((projectList || []).map((p) => [p.id, p])));
      setProjects(
        (projectList || [])
          .map((p) => {
            // Explicit membership only: this lists the projects this account
            // was added to, so an admin's implicit reach does not belong here.
            const role = projectRole(p, userId);
            return { id: p.id, name: p.name, project: p, role };
          })
          .filter((p) => p.role),
      );
      // A revoked token is kept for the audit log but no longer works.
      setTokens((tokenList || []).filter((tok) => !tok.revokedAt));
      setTally(tallyRows?.[0] || null);
    } catch (err) {
      if (!isCurrent()) return;
      setUser(null);
      if (err?.status === 404) {
        setMissing(true);
        return;
      }
      console.error('Error loading user:', err);
      notifyError(humanizeError(err), t('Failed to load the account'));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [client, userId, begin]);

  useEffect(() => {
    load();
  }, [load]);

  const revokeToken = async (token) => {
    const ok = await confirm({
      title: t('Revoke this token?'),
      description: t('Anything using "{name}" stops working immediately.', { name: token.name }),
      confirmLabel: t('Revoke'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await client.apiTokens.revoke(userId, token.id);
      setTokens((ts) => ts.filter((tok) => tok.id !== token.id));
      notifySuccess(t('Token revoked'));
    } catch (err) {
      notifyError(humanizeError(err), t('Failed to revoke the token'));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link to={backTo}>
          <ArrowLeft className="h-4 w-4" /> {t('All accounts')}
        </Link>
      </Button>

      {loading && !user ? (
        <Loading className="p-0" />
      ) : missing ? (
        <p className="text-sm text-muted-foreground">{t('There is no account at this address.')}</p>
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
              <h2 className={cn('flex items-center gap-2', TYPE.section)}>
                {user.displayName || user.id}
                {user.isAdmin && <Badge variant="secondary">{t('Admin')}</Badge>}
                {user.deactivatedAt && <Badge variant="outline">{t('Deactivated')}</Badge>}
              </h2>
              <p className="text-sm text-muted-foreground">{user.id}</p>
            </div>
            <Button variant="outline" size="sm" className="ml-auto" onClick={() => onEdit(user)}>
              {t('Edit')}
            </Button>
          </div>

          {tally && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[
                [t('Changes'), tally.changes.toLocaleString()],
                [t('By services and jobs'), tally.delegatedChanges.toLocaleString()],
                [t('Documents'), tally.documents.toLocaleString()],
                [t('First'), timeAgo(tally.firstTs)],
                [t('Last'), timeAgo(tally.lastTs)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div className="text-lg font-semibold tabular-nums">{value}</div>
                </div>
              ))}
            </div>
          )}

          <DataTable
            title={t('Projects')}
            rows={projects}
            columns={[
              {
                key: 'name',
                label: t('Project'),
                sort: (p) => p.name,
                compare: compareNames,
                render: (p) => (
                  <ProjectLink project={p.project} className="hover:underline">
                    {p.name}
                  </ProjectLink>
                ),
              },
              {
                key: 'role',
                label: t('Role'),
                sort: (p) => p.role,
                align: 'right',
                className: 'text-muted-foreground',
                render: (p) =>
                  t(
                    '{role, select, reader {Reader} writer {Writer} maintainer {Maintainer} other {{role}}}',
                    { role: p.role },
                  ),
              },
            ]}
            rowKey={(p) => p.id}
            id="user-projects"
            defaultSort={{ key: 'name', dir: 'asc' }}
            search={{
              placeholder: t('Search projects…'),
              match: (p, q) => textIncludes(p.name, q),
            }}
            noun="project"
            empty={t('No project roles.')}
            noMatch={t('No projects match.')}
          />

          <DataTable
            title={t('API tokens')}
            rows={tokens}
            columns={[
              {
                key: 'name',
                label: t('Name'),
                sort: (tok) => (tok.name || '').toLowerCase(),
                render: (tok) => tok.name,
              },
              {
                key: 'created',
                label: t('Created'),
                sort: (tok) => (tok.createdAt ? new Date(tok.createdAt).getTime() : null),
                className: 'text-muted-foreground',
                render: (tok) => (
                  <span title={fullTimestamp(tok.createdAt)}>{timeAgo(tok.createdAt)}</span>
                ),
              },
              {
                key: 'lastWrite',
                label: t('Last write'),
                sort: (tok) => (tok.lastWriteAt ? new Date(tok.lastWriteAt).getTime() : null),
                className: 'text-muted-foreground',
                render: (tok) =>
                  tok.lastWriteAt ? (
                    <span title={fullTimestamp(tok.lastWriteAt)}>{timeAgo(tok.lastWriteAt)}</span>
                  ) : (
                    t('Never')
                  ),
              },
              {
                key: 'actions',
                label: '',
                headerClassName: 'w-24',
                align: 'right',
                render: (tok) => (
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    onClick={() => revokeToken(tok)}
                  >
                    {t('Revoke')}
                  </Button>
                ),
              },
            ]}
            rowKey={(tok) => tok.id}
            id="user-tokens"
            defaultSort={{ key: 'created', dir: 'desc' }}
            noun="token"
            empty={t('No active tokens.')}
          />

          <AuditFeed
            title={t('Recent activity')}
            id="user-activity"
            resetKey={userId}
            projectHref={(project) => projectTarget(projectsById.get(project.id) ?? project)}
            documentHref={(document, project) =>
              documentTarget(document, projectsById.get(project.id) ?? project)
            }
            empty={t('Nothing recorded.')}
            fetchPage={({ limit, cursor }) =>
              client.users.auditPage(userId, { limit, cursor, order: 'desc', opsLimit: 1 })
            }
          />
        </>
      )}
      {dialogs}
    </div>
  );
};
