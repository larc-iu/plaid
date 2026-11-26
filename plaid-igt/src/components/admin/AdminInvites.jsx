import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link2, Copy, Check } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { Badge } from '@ui/components/ui/badge';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@ui/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@ui/components/ui/dialog';
import { DataTable } from '@ui/components/shared/data-table';
import { timeAgo, fullTimestamp } from '@ui/lib/formatTime.js';
import { notifySuccess, notifyError, humanizeError } from '@/utils/feedback';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { InviteStatusBadge } from '@ui/components/shared/InviteStatusBadge.jsx';
import { inviteLinkFor, GRANT_ROLES, inviteRevocable } from '@ui/domain/invites.js';
import { ProjectLink } from './ProjectLink';
import { ROLE_HINTS } from '@/domain/roleGrants.js';
import { textIncludes } from '@ui/domain/collation.js';
import { t, tc } from '@ui/lib/i18n.js';
import { copyText } from '@ui/lib/download.js';

// Every invite on the server, whoever minted it. A project's own tab shows
// that project's links; this is the one place an admin can see an admin grant
// somebody else handed out, and the one place to mint a link that grants no
// project.

const EMPTY_BATCH = { uses: '20', role: 'writer', ttlDays: '30', note: '', projectId: '' };

// The project choice for links that create an account and grant nothing else.
const NO_PROJECT = 'none';

// The minted link, shown once. Nothing stores a code, so this is the only
// chance to capture it.
const LinkResult = ({ link, onClose }) => {
  const [copied, setCopied] = useState(false);
  const text = link ? inviteLinkFor(link.code) : '';

  const copy = async () => {
    if (!(await copyText(text, t('Select the link and copy it by hand.')))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={Boolean(link)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('Link created')}</DialogTitle>
          <DialogDescription>
            {t(
              'Copy it now. It cannot be shown again. It creates up to {n, plural, one {# account} other {# accounts}}.',
              { n: link?.maxUses ?? 0 },
            )}
          </DialogDescription>
        </DialogHeader>
        <Input
          readOnly
          value={text}
          aria-label={t('Invite link')}
          className="font-mono text-xs"
          onFocus={(e) => e.target.select()}
        />
        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={copy}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {t('Copy')}
          </Button>
          <Button onClick={onClose}>{t('Done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const AdminInvites = ({ client }) => {
  const confirm = useConfirm();
  const [invites, setInvites] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  // A list that could not be read is not an empty one.
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState('all');
  const [batchOpen, setBatchOpen] = useState(false);
  const [batch, setBatch] = useState(EMPTY_BATCH);
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, projectList] = await Promise.all([
        client.invites.list({ all: true }),
        client.projects.list(),
      ]);
      setInvites(rows || []);
      setProjects(projectList || []);
      setLoadFailed(false);
    } catch (err) {
      console.error('Error loading invites:', err);
      setLoadFailed(true);
      notifyError(humanizeError(err), t('Failed to load the invitations'));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const projectName = useCallback(
    (id) => projects.find((p) => p.id === id)?.name || id || '',
    [projects],
  );

  // Only the status filter lives here. The text search and the ordering are
  // the table's, like every other list.
  const rows = useMemo(
    () => (status === 'all' ? invites : invites.filter((i) => i.status === status)),
    [invites, status],
  );

  const mintBatch = async () => {
    const maxUses = Number(batch.uses);
    if (batch.uses === '' || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 200) {
      notifyError(t('Between 1 and 200.'), t('Check the number of uses'));
      return;
    }
    // Blank or 0 must not fall through to the server's default.
    const ttlDays = Number(batch.ttlDays);
    if (batch.ttlDays === '' || !Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 365) {
      notifyError(t('Between 1 and 365.'), t('Check the expiry'));
      return;
    }
    if (!batch.projectId) {
      notifyError(t('Choose a project, or No project.'), t('Project required'));
      return;
    }
    const grant =
      batch.projectId === NO_PROJECT ? {} : { projectId: batch.projectId, projectRole: batch.role };
    setMinting(true);
    try {
      const inv = await client.invites.create({
        ...grant,
        ttlDays,
        maxUses,
        note: batch.note || undefined,
      });
      setMinted({ code: inv.code, maxUses });
      setBatchOpen(false);
      setBatch(EMPTY_BATCH);
      await load();
    } catch (err) {
      console.error('Error minting invite:', err);
      notifyError(humanizeError(err), t('Failed to create the link'));
    } finally {
      setMinting(false);
    }
  };

  const revoke = async (invite) => {
    const ok = await confirm({
      title: t('Revoke this link?'),
      description: invite.note
        ? t('{note} stops working immediately. Accounts already created keep their access.', {
            note: invite.note,
          })
        : t('The link stops working immediately. Accounts already created keep their access.'),
      confirmLabel: t('Revoke'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await client.invites.revoke(invite.id);
      notifySuccess(t('Link revoked'));
      await load();
    } catch (err) {
      notifyError(humanizeError(err), t('Failed to revoke the invitation'));
    }
  };

  const columns = [
    {
      key: 'note',
      label: t('Note'),
      sort: (i) => (i.note || '').toLowerCase(),
      render: (i) => i.note || <span className="text-muted-foreground">{t('Untitled')}</span>,
    },
    {
      key: 'grants',
      label: t('Grants'),
      sort: (i) => (i.grantAdmin ? 'admin' : projectName(i.projectId).toLowerCase()),
      render: (i) =>
        i.kind === 'password-reset' ? (
          <span className="text-muted-foreground">
            {t('Password reset for {user}', { user: i.targetUserId })}
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-1">
            {i.grantAdmin && <Badge variant="destructive">{tc('account', 'Admin')}</Badge>}
            {i.projectId && (
              <ProjectLink
                project={projects.find((p) => p.id === i.projectId) ?? { id: i.projectId }}
                className="hover:underline"
              >
                {projectName(i.projectId)}
              </ProjectLink>
            )}
            {i.projectRole && (
              <span className="text-muted-foreground">
                {t(
                  '{role, select, reader {reader} writer {writer} maintainer {maintainer} other {{role}}}',
                  { role: i.projectRole },
                )}
              </span>
            )}
            {!i.grantAdmin && !i.projectId && (
              <span className="text-muted-foreground">{t('Account only')}</span>
            )}
          </span>
        ),
    },
    {
      key: 'createdBy',
      label: t('Created by'),
      sort: (i) => (i.createdBy || '').toLowerCase(),
      className: 'text-muted-foreground',
      render: (i) => i.createdBy,
    },
    {
      key: 'uses',
      label: t('Uses'),
      sort: (i) => i.uses,
      align: 'right',
      className: 'tabular-nums',
      render: (i) => `${i.uses} / ${i.maxUses}`,
    },
    {
      key: 'expires',
      label: t('Expires'),
      sort: (i) => (i.expiresAt ? new Date(i.expiresAt).getTime() : null),
      className: 'text-muted-foreground',
      render: (i) => <span title={fullTimestamp(i.expiresAt)}>{timeAgo(i.expiresAt)}</span>,
    },
    {
      key: 'status',
      label: t('Status'),
      sort: (i) => i.status,
      render: (i) => <InviteStatusBadge status={i.status} />,
    },
    {
      key: 'actions',
      label: '',
      headerClassName: 'w-20',
      align: 'right',
      render: (i) =>
        inviteRevocable(i.status) ? (
          <Button size="sm" variant="ghost" onClick={() => revoke(i)}>
            {t('Revoke')}
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(i) => i.id}
        id="admin-invites"
        defaultSort={{ key: 'expires', dir: 'desc' }}
        search={{
          placeholder: t('Search invites…'),
          match: (i, q) =>
            textIncludes(i.note || '', q) ||
            textIncludes(i.createdBy || '', q) ||
            textIncludes(projectName(i.projectId), q),
        }}
        countLabel={(v) => t('{total} {n, plural, one {invite} other {invites}}', v)}
        showCount={!loadFailed}
        empty={loadFailed ? t('Not loaded.') : t('No invites.')}
        noMatch={t('No invites match.')}
        loading={loading}
        actions={
          <>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('Any status')}</SelectItem>
                <SelectItem value="active">{t('Active')}</SelectItem>
                <SelectItem value="used">{t('Used')}</SelectItem>
                <SelectItem value="expired">{t('Expired')}</SelectItem>
                <SelectItem value="revoked">{t('Revoked')}</SelectItem>
                <SelectItem value="inactive">{t('Inactive')}</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" onClick={() => setBatchOpen(true)}>
              <Link2 className="h-4 w-4" /> {t('Create link')}
            </Button>
          </>
        }
      />

      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('Create link')}</DialogTitle>
            <DialogDescription>
              {t('One link that creates as many accounts as it has uses.')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-uses">{t('Uses')}</Label>
              <Input
                id="invite-uses"
                type="number"
                min="1"
                max="200"
                value={batch.uses}
                onChange={(e) => setBatch({ ...batch, uses: e.target.value })}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-project">{t('Project')}</Label>
              <Select
                value={batch.projectId}
                onValueChange={(v) => setBatch({ ...batch, projectId: v })}
              >
                <SelectTrigger id="invite-project">
                  <SelectValue placeholder={t('Choose a project')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PROJECT}>{t('No project')}</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {batch.projectId !== NO_PROJECT && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="invite-role">{t('Role')}</Label>
                <Select value={batch.role} onValueChange={(v) => setBatch({ ...batch, role: v })}>
                  <SelectTrigger id="invite-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GRANT_ROLES.map((r) => (
                      <SelectItem key={r} value={r} hint={t(ROLE_HINTS[r])}>
                        {t(
                          '{role, select, reader {Reader} writer {Writer} maintainer {Maintainer} other {{role}}}',
                          { role: r },
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-ttl">{t('Expires in (days)')}</Label>
              <Input
                id="invite-ttl"
                type="number"
                min="1"
                max="365"
                value={batch.ttlDays}
                onChange={(e) => setBatch({ ...batch, ttlDays: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-label">{t('Label')}</Label>
              <Input
                id="invite-label"
                placeholder={t('Field methods Fall 2026')}
                value={batch.note}
                onChange={(e) => setBatch({ ...batch, note: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchOpen(false)} disabled={minting}>
              {t('Cancel')}
            </Button>
            <Button onClick={mintBatch} disabled={minting}>
              {minting ? t('Creating…') : t('Create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LinkResult link={minted} onClose={() => setMinted(null)} />
    </div>
  );
};
