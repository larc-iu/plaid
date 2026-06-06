import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

// "Access Tokens" tab — points at the per-user named API tokens managed on the
// profile page (mirrors plaid-ud). Named tokens are individually revocable and
// attributed by name in the audit log, unlike the raw session token.
export const ProjectAccessTokens = () => {
  return (
    <div className="tw flex flex-col gap-6 pt-4">
      <div className="rounded-lg border bg-card p-4">
        <h2 className="mb-2 text-lg font-semibold">API Access</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          To access the API programmatically from external services like parsers or scripts, create a
          named API token. Unlike your login session, a named token can be revoked individually and its
          name appears in the audit history, so machine-made changes are distinguishable from yours.
        </p>
        <Button asChild variant="outline">
          <Link to="/profile">Manage API Tokens</Link>
        </Button>
        <p className="mt-4 text-xs text-muted-foreground">
          Use a token to initialize a Python <code>PlaidClient</code> instance.
        </p>
      </div>
    </div>
  );
};
