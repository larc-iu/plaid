import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/useAuth.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { appName } from '../../lib/uiConfig.js';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card';
import { PlaidMark } from '../assistant/PlaidMarks.jsx';

/**
 * The sign-in screen. `tagline` is the one line under the app's name, and
 * `homePath` is where a signed-in reader lands, both of them the app's own.
 *
 * Preflight is global, so this wrapper is simply the screen's own root.
 */
export const LoginForm = ({ tagline, homePath }) => {
  useDocumentTitle('Sign In');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Why the login page is showing (set by authService.logout on a 401). The
  // flag is cleared on a successful sign-in, not on read: logout navigates to
  // this route and then hard-reloads, so the form mounts twice.
  const [notice] = useState(() => {
    try {
      const r = sessionStorage.getItem('plaid:logout-reason');
      return r === 'expired' ? 'Your session has expired. Please sign in again.' : '';
    } catch {
      return '';
    }
  });

  const navigate = useNavigate();
  const { login } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await login(email, password);
      if (result.success) {
        try {
          sessionStorage.removeItem('plaid:logout-reason');
        } catch {
          /* storage unavailable */
        }
        navigate(homePath);
      } else {
        setError(result.error || 'Email or password is incorrect.');
      }
    } catch {
      setError('Something went wrong. Try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <PlaidMark className="mb-1 h-10 w-10" />
          <CardTitle className="text-2xl">{appName()} Login</CardTitle>
          <CardDescription>{tagline}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {notice && !error && (
              <div
                role="status"
                className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
              >
                {notice}
              </div>
            )}
            {error && (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={loading}
                autoComplete="username"
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={loading}
                autoComplete="current-password"
              />
            </div>
            <Button type="submit" disabled={loading} className="mt-2 w-full">
              {loading ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};
