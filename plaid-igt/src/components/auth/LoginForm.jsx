import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { notifySuccess } from '@/utils/feedback';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

// First screen migrated from Mantine to shadcn/Tailwind. The `.tw` wrapper opts
// this subtree into the scoped preflight subset (see src/index.css).
export const LoginForm = () => {
  useDocumentTitle('Sign In');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
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
    if (!email) return setError('Email address is required');
    if (!password) return setError('Password is required');

    setLoading(true);
    try {
      const result = await login(email, password);
      if (result.success) {
        try {
          sessionStorage.removeItem('plaid:logout-reason');
        } catch {
          /* storage unavailable */
        }
        notifySuccess('Login successful!', 'Success');
        navigate('/projects');
      } else {
        setError(result.error || 'Login failed. Please check your credentials.');
      }
    } catch {
      setError('An unexpected error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="tw flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <CardTitle className="text-2xl">Plaid IGT Login</CardTitle>
          <CardDescription>Plaid Annotation Interface</CardDescription>
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
                disabled={loading}
                autoComplete="username"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                autoComplete="current-password"
              />
            </div>
            <Button type="submit" disabled={loading} className="mt-2 w-full">
              {loading ? 'Logging in…' : 'Login'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};
