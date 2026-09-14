import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { notifyError } from '../../lib/notify.js';
import { inviteLinkFor } from '../../domain/invites.js';

/**
 * One freshly-minted invite link, shown once. The code is not stored anywhere
 * and the server cannot produce it again, so this dialog is the only chance to
 * capture it: hence the copy button and the warning.
 */
export const MintedLinkDialog = ({ code, onClose, title = 'Invitation link created' }) => {
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
    <Dialog open={!!code} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Copy this link now. It is not shown again.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            readOnly
            value={link}
            className="flex-1 font-mono text-xs"
            aria-label="Invitation link"
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
