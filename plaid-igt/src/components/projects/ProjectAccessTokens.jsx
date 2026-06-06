import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { notifySuccess } from '@/utils/feedback';

// "Access Tokens" tab — parity with plaid-ud's. NOTE: plaid-igt doesn't yet have
// named, per-token API tokens (revocable + audit-attributed) the way plaid-ud's
// profile does, so for now this copies the current session token. Swap to named
// tokens once the profile grows them.
export const ProjectAccessTokens = () => {
  const [copied, setCopied] = useState(false);

  const handleCopyToken = () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    notifySuccess('Your authentication token has been copied to clipboard', 'Token copied');
  };

  return (
    <div className="tw flex flex-col gap-6 pt-4">
      <div className="rounded-lg border bg-card p-4">
        <h2 className="mb-2 text-lg font-semibold">API Access</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          To access the API programmatically from external services like parsers or scripts, use your
          authentication token. Keep it secure — anyone holding it can act as you.
        </p>
        <Button onClick={handleCopyToken}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Copied!' : 'Copy Token'}
        </Button>
        <p className="mt-4 text-xs text-muted-foreground">
          Use it to initialize a Python <code>PlaidClient</code> instance.
        </p>
      </div>
    </div>
  );
};
