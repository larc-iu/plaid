import { Link } from 'react-router-dom';

import { Button } from '../ui/button.jsx';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card.jsx';

// "API tokens", the second part of a project's Access settings: a pointer to
// named API tokens, which are managed per-user on the profile page.
// Programmatic access from an external service uses a named token, which is
// individually revocable and attributed by name in the audit log. The content
// is project-agnostic, so it fetches nothing. `profileHref` is the app's, since
// a route is not the package's to know.
export const ProjectAccessTokens = ({ profileHref }) => (
  <Card>
    <CardHeader>
      <CardTitle>API tokens</CardTitle>
    </CardHeader>
    <CardContent className="flex flex-col items-start gap-4">
      <p className="text-sm text-muted-foreground">
        Named tokens for a parser, a script or another service, each revoked on its own.
      </p>
      <Button asChild variant="outline">
        <Link to={profileHref}>Manage API tokens</Link>
      </Button>
    </CardContent>
  </Card>
);
