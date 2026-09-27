import { useState, useEffect, useRef } from 'react';
import {
  PLAID_NAMESPACE,
  REVIEW_KEY,
  isReviewed,
  projectRole,
  readReview,
  withReviewedUser,
} from '@larc-iu/plaid-client';
import { Badge } from '../ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { DataTable } from './data-table';
import { UserAvatar } from './UserAvatar';
import { notifyError } from '../../lib/notify.js';
import { ROLE_RANK, aclMemberIds, roleOf, setProjectRole } from '../../domain/projectRoles.js';

/**
 * Everyone explicitly granted a role on a project, what they may do, and whose
 * work is reviewed.
 *
 * Members come from the project's ACL rather than from the roster: the roster
 * is admin-gated and does not scale. An admin who was explicitly added shows
 * with a badge; an admin with only implicit access is not in the ACL and never
 * appears.
 *
 * `roleOptions` is the app's, because two of the four hints are written in the
 * app's own vocabulary. `headerAction` and `renderActions` are the app's
 * account administration, which differs between them.
 */
export const ProjectMembers = ({
  project,
  projectId,
  client,
  currentUser,
  onDataUpdate,
  roleOptions,
  headerAction = null,
  renderActions = null,
}) => {
  const [members, setMembers] = useState([]);
  const [membersLoading, setMembersLoading] = useState(true);
  // Role and review changes show at once, before the server has them. Each map
  // holds what a row was changed to (user id -> role, or -> reviewed) until
  // the project, refetched, says the same. A refused change is taken out
  // again. `sendingRole` is the rows whose role change is on its way: a second
  // change to the same row waits for it, since each is a remove then an add.
  const [shownRole, setShownRole] = useState(() => new Map());
  const [shownReview, setShownReview] = useState(() => new Map());
  const [sendingRole, setSendingRole] = useState(() => new Set());
  // Review marks are one list in the project config. They are sent one at a
  // time, and each write is worked out when its turn comes, from the project
  // as it stands then and the marks still shown, so a refused one is not
  // carried by the next. `reviewMarks` counts each row's clicks, so a refusal
  // takes back only its own mark and not one made after it.
  const reviewTail = useRef(Promise.resolve());
  const pendingReview = useRef(new Map());
  const reviewMarks = useRef(new Map());
  const projectRef = useRef(project);
  projectRef.current = project;

  // Resolve ACL member ids to user objects (project-sized, so per-id GETs are
  // fine). Keyed on WHO is on the ACL, not on the project object: a refetch
  // that changed only config (the review mark) or the name must neither
  // re-resolve nor blank the table. Roles are read off the project at render
  // (see `rows`), so a role change shows the moment the project refreshes.
  // The spinner shows only before the first resolve; a later one (someone
  // added or removed) swaps the rows in place.
  const aclKey = aclMemberIds(project).join('\n');
  const projectLoaded = !!project;
  const membersRef = useRef(members);
  membersRef.current = members;
  useEffect(() => {
    if (!projectLoaded) return;
    let cancelled = false;
    (async () => {
      if (membersRef.current.length === 0) setMembersLoading(true);
      const ids = aclKey ? aclKey.split('\n') : [];
      try {
        const resolved = await Promise.all(
          ids.map((id) =>
            client.users.get(id).catch(() => ({ id, displayName: id, isAdmin: false })),
          ),
        );
        resolved.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
        if (!cancelled) setMembers(resolved);
      } catch (err) {
        console.error('Error resolving members:', err);
        if (!cancelled) setMembers([]);
      } finally {
        if (!cancelled) setMembersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [aclKey, projectLoaded, client]);

  // Drop what the refetched project now agrees with.
  useEffect(() => {
    const settled = (map, stored) => {
      const next = new Map([...map].filter(([id, value]) => stored(id) !== value));
      return next.size === map.size ? map : next;
    };
    setShownRole((m) => settled(m, (id) => roleOf(project, id)));
    pendingReview.current = settled(pendingReview.current, (id) =>
      readReview(project?.config).users.includes(id),
    );
    setShownReview(pendingReview.current);
  }, [project]);

  const withEntry = (map, key, value) => {
    const next = new Map(map);
    if (value === undefined) next.delete(key);
    else next.set(key, value);
    return next;
  };

  const rows = members.map((m) => ({
    ...m,
    role: shownRole.has(m.id) ? shownRole.get(m.id) : roleOf(project, m.id),
  }));

  // The refetch after a change that landed. Its failure is not the change's:
  // the row already shows what the server holds.
  const refetch = async () => {
    try {
      await onDataUpdate();
    } catch (err) {
      console.error('Error refreshing the project:', err);
    }
  };

  const setRole = async (userId, newRole) => {
    if (userId === currentUser?.id || sendingRole.has(userId)) return;
    setShownRole((m) => withEntry(m, userId, newRole));
    setSendingRole((s) => new Set(s).add(userId));
    try {
      await setProjectRole({
        client,
        project,
        projectId,
        userId,
        newRole,
        currentUserId: currentUser?.id,
        onDataUpdate: refetch,
      });
    } catch (err) {
      console.error('Error updating role:', err);
      setShownRole((m) => withEntry(m, userId, undefined));
      notifyError(err, 'Failed to update permissions');
      // A role change is a remove then an add, and the add may be the half
      // that was refused.
      await refetch();
    } finally {
      setSendingRole((s) => {
        const next = new Set(s);
        next.delete(userId);
        return next;
      });
    }
  };

  // Whose work is reviewed (the cross-app `plaid.review` norm, provenance
  // convention): a marked member's annotations are recorded as contributed
  // until a verifier confirms them. Independent of the role: any member can be
  // marked. A project may also mark whole roles (another app's setting); such
  // members show as reviewed and cannot be unmarked one by one here.
  const reviewedByRole = (m) => {
    const { users, roles } = readReview(project?.config);
    return (
      !users.includes(m.id) && roles.includes(projectRole(project, m.id, { isAdmin: m.isAdmin }))
    );
  };

  const showReview = (userId, on) => {
    pendingReview.current = withEntry(pendingReview.current, userId, on);
    setShownReview(pendingReview.current);
  };

  const setReviewed = (userId, on) => {
    showReview(userId, on);
    const mark = (reviewMarks.current.get(userId) || 0) + 1;
    reviewMarks.current.set(userId, mark);
    const send = async () => {
      // The stored list with every mark still shown over it.
      let next = projectRef.current?.config?.[PLAID_NAMESPACE]?.[REVIEW_KEY];
      for (const [id, mark] of pendingReview.current) next = withReviewedUser(next, id, mark);
      try {
        await client.projects.setConfig(projectId, PLAID_NAMESPACE, REVIEW_KEY, next);
      } catch (err) {
        console.error('Error updating review:', err);
        // A later click on this row is still shown and still to be sent.
        if (reviewMarks.current.get(userId) === mark) showReview(userId, undefined);
        notifyError(err, 'Failed to update review');
        return;
      }
      await refetch();
    };
    reviewTail.current = reviewTail.current.then(send);
  };

  const reviewedShown = (m) =>
    shownReview.has(m.id)
      ? shownReview.get(m.id)
      : isReviewed(project, m.id, { isAdmin: m.isAdmin });

  const columns = [
    {
      key: 'user',
      label: 'User',
      sort: (m) => (m.displayName || '').toLowerCase(),
      render: (m) => (
        <div className="flex items-center gap-2">
          <UserAvatar
            client={client}
            userId={m.id}
            displayName={m.displayName}
            avatarHash={m.avatarHash}
            className="h-7 w-7"
          />
          <div className="min-w-0 [overflow-wrap:anywhere]">
            <div className="flex flex-wrap items-center gap-x-2">
              <span className="font-medium">{m.displayName}</span>
              {m.isAdmin && <Badge variant="secondary">Admin</Badge>}
            </div>
            <span className="text-xs text-muted-foreground">{m.id}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      label: 'Project role',
      sort: (m) => ROLE_RANK[m.role] ?? ROLE_RANK.none,
      render: (m) => (
        <>
          <Select
            value={m.role}
            onValueChange={(v) => setRole(m.id, v)}
            disabled={m.id === currentUser?.id || sendingRole.has(m.id)}
          >
            <SelectTrigger className="h-8 w-36" aria-label={`${m.displayName} project role`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roleOptions.map((o) => (
                <SelectItem key={o.value} value={o.value} hint={o.hint}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {m.id === currentUser?.id && (
            <p className="mt-0.5 text-xs text-muted-foreground">Your own access</p>
          )}
        </>
      ),
    },
    {
      key: 'review',
      label: (
        <span title="Their annotations are marked as contributed until a verifier confirms them">
          Review work
        </span>
      ),
      // The stored mark, not the box: a toggle in flight would otherwise move
      // the row out from under the click that made it.
      sort: (m) => (isReviewed(project, m.id, { isAdmin: m.isAdmin }) ? 0 : 1),
      render: (m) => (
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
          aria-label={`Review ${m.displayName}'s work`}
          checked={reviewedShown(m)}
          disabled={reviewedByRole(m)}
          title={
            reviewedByRole(m)
              ? `Every ${projectRole(project, m.id, { isAdmin: m.isAdmin })} is reviewed in this project`
              : undefined
          }
          onChange={(e) => setReviewed(m.id, e.target.checked)}
        />
      ),
    },
    ...(renderActions
      ? [{ key: 'actions', label: '', headerClassName: 'w-12', render: renderActions }]
      : []),
  ];

  return (
    <div>
      <div className="flex items-center justify-between gap-2 pb-3">
        <h2 className="text-lg font-semibold">Members</h2>
        {headerAction}
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(m) => m.id}
        id="project-members"
        scope={projectId}
        defaultSort={{ key: 'user', dir: 'asc' }}
        noun="member"
        loading={membersLoading}
        empty="No one has been granted access yet. Use “Add a user” below."
      />
    </div>
  );
};
