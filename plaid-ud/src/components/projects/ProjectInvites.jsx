import { useState, useEffect, useCallback } from 'react';
import { Check, Copy, Link2, Trash2 } from 'lucide-react';
import PlaidClient from '@larc-iu/plaid-client';
import { notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { Badge } from '@ui/components/ui/badge';
import { Button } from '@ui/components/ui/button';
import { DataTable } from '@ui/components/ui/data-table';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@ui/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ui/components/ui/select';

const GRANT_ROLES = [
  { value: 'reader', label: 'Reader' },
  { value: 'writer', label: 'Writer' },
  { value: 'maintainer', label: 'Maintainer' },
];

const STATUS_VARIANT = {
  active: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700',
  used: 'border-border bg-muted text-muted-foreground',
  expired: 'border-border bg-muted text-muted-foreground',
  revoked: 'border-destructive/40 bg-destructive/10 text-destructive',
};

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
};

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

// The server never learns the app's public URL, so the app that minted the
// invite is the one that names it. `window.location` is authoritative here in a
// way no server config could be: it is literally where this user is.
const inviteLinkFor = (code) => {
  const { origin, pathname } = window.location;
  return PlaidClient.inviteUrl(`${origin}${pathname}`, code);
};

// Shown once, immediately after minting. The code is not stored anywhere and
// the server cannot produce it again, so this dialog is the only chance to
// capture it — hence the copy button and the explicit warning.
export const MintedLinkModal = ({ code, onClose, title = 'Invitation link created' }) => {
  const link = code ? inviteLinkFor(code) : '';
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard?.writeText(link).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={!!code} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Copy this link now. It is not stored, so it cannot be shown again. If you lose it, revoke
          this invite and create another.
        </p>
        <div className="flex items-center gap-2">
          <Input
            readOnly
            value={link}
            className="flex-1 font-mono text-xs"
            onFocus={(e) => e.target.select()}
            aria-label="Invitation link"
          />
          <Button variant="outline" onClick={copy} aria-label="Copy invite link">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const ProjectInvites = ({ projectId, projectName, client, canManage }) => {
  const confirm = useConfirm();
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [role, setRole] = useState('writer');
  const [maxUses, setMaxUses] = useState(1);
  const [ttlDays, setTtlDays] = useState(14);
  const [note, setNote] = useState('');
  const [creating, setCreating] = useState(false);
  const [mintedCode, setMintedCode] = useState(null);

  const load = useCallback(async () => {
    if (!canManage) return;
    try {
      setLoading(true);
      setInvites((await client.invites.list({ projectId })) || []);
    } catch (err) {
      console.error('Error loading invites:', err);
      notifyError('Failed to load invitation links');
    } finally {
      setLoading(false);
    }
  }, [client, projectId, canManage]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    try {
      setCreating(true);
      const inv = await client.invites.create({
        projectId,
        projectRole: role,
        maxUses,
        ttlDays,
        note: note.trim() || undefined,
      });
      setCreateOpen(false);
      setNote('');
      setMintedCode(inv.code);
      await load();
    } catch (err) {
      console.error('Error creating invite:', err);
      notifyError(err.message || 'Failed to create invitation link');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (inv) => {
    const ok = await confirm({
      title: 'Revoke this invitation link',
      description:
        'The link stops working immediately. Anyone who already used it keeps their account and access.',
      confirmLabel: 'Revoke link',
      destructive: true,
    });
    if (!ok) return;
    try {
      await client.invites.revoke(inv.id);
      notifySuccess('Invitation link revoked');
      await load();
    } catch (err) {
      console.error('Error revoking invite:', err);
      notifyError('Failed to revoke invitation link');
    }
  };

  if (!canManage) return null;

  const columns = [
    {
      key: 'note',
      label: 'Label',
      sort: (i) => (i.note || '').toLowerCase(),
      render: (i) => i.note || <span className="italic text-muted-foreground">Untitled</span>,
    },
    {
      key: 'role',
      label: 'Grants',
      sort: (i) => i.projectRole,
      render: (i) => cap(i.projectRole),
    },
    {
      key: 'uses',
      label: 'Used',
      sort: (i) => i.uses,
      render: (i) => `${i.uses} / ${i.maxUses}`,
    },
    {
      key: 'expires',
      label: 'Expires',
      sort: (i) => (i.expiresAt ? new Date(i.expiresAt).getTime() : null),
      render: (i) => fmtDate(i.expiresAt),
    },
    {
      key: 'status',
      label: 'Status',
      sort: (i) => i.status,
      render: (i) => (
        <Badge variant="outline" className={STATUS_VARIANT[i.status] || STATUS_VARIANT.used}>
          {i.status}
        </Badge>
      ),
    },
    {
      key: 'actions',
      label: '',
      align: 'right',
      headerClassName: 'w-12',
      render: (i) =>
        i.status === 'active' ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive"
            aria-label="Revoke invitation link"
            onClick={() => handleRevoke(i)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="tw mb-6 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">Invitation links</h3>
          <p className="text-sm text-muted-foreground">
            Send someone a link instead of a password. They choose their own credentials and join{' '}
            {projectName || 'this project'} automatically.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Link2 className="h-4 w-4" /> New link
        </Button>
      </div>

      <DataTable
        rows={invites}
        columns={columns}
        rowKey={(i) => i.id}
        id="invites"
        scope={projectId}
        defaultSort={{ key: 'expires', dir: 'desc' }}
        noun="link"
        loading={loading}
        empty="No invitation links yet."
        showCount={false}
      />

      <Dialog open={createOpen} onOpenChange={(open) => !open && setCreateOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New invitation link</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Anyone with the link can create one account and join this project.
          </p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invite-role">They join as</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GRANT_ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex gap-4">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="invite-uses">Number of uses</Label>
              <Input
                id="invite-uses"
                type="number"
                min={1}
                value={maxUses}
                onChange={(e) => setMaxUses(Math.max(1, Number(e.target.value) || 1))}
              />
              <p className="text-xs text-muted-foreground">
                Raise this to share one link with a whole class.
              </p>
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="invite-ttl">Expires in (days)</Label>
              <Input
                id="invite-ttl"
                type="number"
                min={1}
                value={ttlDays}
                onChange={(e) => setTtlDays(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invite-note">Label (optional)</Label>
            <Input
              id="invite-note"
              placeholder="e.g. Fall 2026 field methods"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Only you see this. It is how you will recognize the link later.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? 'Creating…' : 'Create link'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MintedLinkModal code={mintedCode} onClose={() => setMintedCode(null)} />
    </div>
  );
};
