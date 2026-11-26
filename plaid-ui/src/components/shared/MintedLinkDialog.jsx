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
import { copyText } from '../../lib/download.js';
import { inviteLinkFor } from '../../domain/invites.js';
import { t } from '../../lib/i18n.js';

/**
 * One freshly-minted invite link, shown once. The code is not stored anywhere
 * and the server cannot produce it again, so this dialog is the only chance to
 * capture it: hence the copy button and the warning.
 */
export const MintedLinkDialog = ({ code, onClose, title = t('Invitation link created') }) => {
  const [copied, setCopied] = useState(false);
  const link = code ? inviteLinkFor(code) : '';

  const copy = async () => {
    if (!(await copyText(link, t('Select the link and copy it manually.'), t('Failed to copy'))))
      return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={!!code} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t('Copy this link now. It is not shown again.')}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            readOnly
            value={link}
            className="flex-1 font-mono text-xs"
            aria-label={t('Invitation link')}
            onFocus={(e) => e.target.select()}
          />
          <Button variant="outline" size="icon" onClick={copy} aria-label={t('Copy invite link')}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t('Done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
