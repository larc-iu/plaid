import { useState, useEffect, useCallback } from 'react';
import { Link2, Copy, Check, Trash2 } from 'lucide-react';
import PlaidClient from '@larc-iu/plaid-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { notifySuccess, notifyError } from '@/utils/feedback';

const GRANT_ROLES = ['reader', 'writer', 'maintainer'];
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const EMPTY_FORM = { role: 'writer', maxUses: '1', ttlDays: '14', note: '' };

const STATUS_VARIANT = {
  active: 'default',
  used: 'secondary',
  expired: 'secondary',
  revoked: 'outline',
};

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
};

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
const MintedLinkDialog = ({ code, onClose, title = 'Invitation link created' }) => {
  const [copied, setCopied] = useState(false);
  const link = code ? inviteLinkFor(code) : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notifyError('Could not copy. Select the link and copy it manually.', 'Copy failed');
    }
  };

  return (
    <Dialog open={!!code} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Copy this link now. It is not stored, so it cannot be shown again — if you lose it,
            revoke this invite and create another.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            readOnly
            value={link}
            className="font-mono text-xs"
            onFocus={(e) => e.target.select()}
          />
          <Button variant="outline" size="icon" onClick={copy} aria-label="Copy invite link">
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
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [mintedCode, setMintedCode] = useState(null);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    if (!canManage) return;
    try {
      setLoading(true);
      setInvites((await client.invites.list({ projectId })) || []);
    } catch (err) {
      console.error('Error loading invites:', err);
      notifyError('Failed to load invitation links', 'Error');
    } finally {
      setLoading(false);
    }
  }, [client, projectId, canManage]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    const maxUses = parseInt(form.maxUses, 10);
    const ttlDays = parseInt(form.ttlDays, 10);
    if (!Number.isInteger(maxUses) || maxUses < 1) {
      notifyError('Number of uses must be at least 1', 'Error');
      return;
    }
    if (!Number.isInteger(ttlDays) || ttlDays < 1) {
      notifyError('Expiry must be at least 1 day', 'Error');
      return;
    }
    try {
      setCreating(true);
      const inv = await client.invites.create({
        projectId,
        projectRole: form.role,
        maxUses,
        ttlDays,
        note: form.note.trim() || undefined,
      });
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      setMintedCode(inv.code);
      await load();
    } catch (err) {
      console.error('Error creating invite:', err);
      notifyError(err.message || 'Failed to create invitation link', 'Error');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    try {
      setRevoking(true);
      await client.invites.revoke(revokeTarget.id);
      notifySuccess('Invitation link revoked', 'Success');
      setRevokeTarget(null);
      await load();
    } catch (err) {
      console.error('Error revoking invite:', err);
      notifyError('Failed to revoke invitation link', 'Error');
    } finally {
      setRevoking(false);
    }
  };

  if (!canManage) return null;

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <h2 className="text-lg font-semibold">Invitation links</h2>
          <p className="text-sm text-muted-foreground">
            Send someone a link instead of a password. They choose their own credentials and join{' '}
            {projectName ? <strong>{projectName}</strong> : 'this project'} automatically.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Link2 className="h-4 w-4" /> New link
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-8 text-muted-foreground">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
        </div>
      ) : invites.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          No invitation links yet. Create one to onboard someone without sending a password.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="px-4 py-2 font-medium">Label</th>
              <th className="px-4 py-2 font-medium">Grants</th>
              <th className="px-4 py-2 font-medium">Used</th>
              <th className="px-4 py-2 font-medium">Expires</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="w-12 px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {invites.map((inv) => (
              <tr key={inv.id} className="border-t">
                <td className="px-4 py-2">
                  {inv.note || <em className="text-muted-foreground">Untitled</em>}
                </td>
                <td className="px-4 py-2">{cap(inv.projectRole)}</td>
                <td className="px-4 py-2">
                  {inv.uses} / {inv.maxUses}
                </td>
                <td className="px-4 py-2">{fmtDate(inv.expiresAt)}</td>
                <td className="px-4 py-2">
                  <Badge variant={STATUS_VARIANT[inv.status] || 'secondary'}>{inv.status}</Badge>
                </td>
                <td className="px-4 py-2">
                  {inv.status === 'active' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label="Revoke invitation link"
                      onClick={() => setRevokeTarget(inv)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New invitation link</DialogTitle>
            <DialogDescription>
              Anyone with the link can create one account and join this project.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>They join as</Label>
              <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GRANT_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {cap(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="invite-uses">Number of uses</Label>
                <Input
                  id="invite-uses"
                  type="number"
                  min="1"
                  value={form.maxUses}
                  onChange={(e) => setForm({ ...form, maxUses: e.target.value })}
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
                  min="1"
                  value={form.ttlDays}
                  onChange={(e) => setForm({ ...form, ttlDays: e.target.value })}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-note">Label (optional)</Label>
              <Input
                id="invite-note"
                placeholder="e.g. Fall 2026 field methods"
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Only you see this. It is how you will recognize the link later.
              </p>
            </div>
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

      <MintedLinkDialog code={mintedCode} onClose={() => setMintedCode(null)} />

      <AlertDialog open={!!revokeTarget} onOpenChange={(o) => !o && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this invitation link?</AlertDialogTitle>
            <AlertDialogDescription>
              The link stops working immediately. Anyone who already used it keeps their account and
              access.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleRevoke();
              }}
              disabled={revoking}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revoking ? 'Revoking…' : 'Revoke link'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export { inviteLinkFor, MintedLinkDialog };
