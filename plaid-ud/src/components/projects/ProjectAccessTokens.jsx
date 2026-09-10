import { Link } from 'react-router-dom';
import { Button } from '@ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';

// "Access Tokens": a pointer to named API tokens, which are managed per-user on
// the profile page. Programmatic access from an external service uses a named
// token, which is individually revocable and attributed by name in the audit
// log. The content is project-agnostic, so it fetches nothing.
export const ProjectAccessTokens = () => (
  <Card className="tw">
    <CardHeader>
      <CardTitle className="text-lg">API access</CardTitle>
    </CardHeader>
    <CardContent className="flex flex-col items-start gap-4">
      <p className="text-sm text-muted-foreground">
        To reach the API from an external service such as a parser or a script, create a named API
        token. Unlike your login session, a named token can be revoked on its own, and its name
        appears in the audit history, so machine-made changes are distinguishable from yours.
      </p>
      <Button asChild variant="outline">
        <Link to="/profile">Manage API tokens</Link>
      </Button>
      <p className="text-xs text-muted-foreground">
        Use a token to initialize a Python <code>PlaidClient</code> instance.
      </p>
    </CardContent>
  </Card>
);
