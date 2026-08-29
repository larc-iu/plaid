import { useState, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { authService } from '../../services/auth';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { notifySuccess } from '@/utils/feedback';
import { isEmail, EMAIL_REQUIRED_MESSAGE, EMAIL_INVALID_MESSAGE } from '@/utils/email';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

// Matches the server's minimum. Stated up front rather than only on rejection:
// this is the one password the user will have to remember, and finding out the
// rule after typing it twice is a bad first minute with the app.
const MIN_PASSWORD = 8;

// Why a code can be dead, in the words the holder needs. The server sends the
// status because the holder already has the code — there is nothing left to
// withhold, and "invalid" alone leaves them with no idea what to do next.
const DEAD_STATUS_MESSAGE = {
  used: 'This invite has already been used. Ask whoever sent it for a new link.',
  expired: 'This invite has expired. Ask whoever sent it for a new link.',
  revoked: 'This invite has been revoked. Ask whoever sent it for a new link.',
};

export const RedeemInvite = () => {
  const { code } = useParams();
  const navigate = useNavigate();
  const { redeemInvite, user } = useAuth();

  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lookupError, setLookupError] = useState('');

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const isReset = preview?.kind === 'password-reset';
  useDocumentTitle(isReset ? 'Set a New Password' : 'Accept Invitation');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pv = await authService.lookupInvite(code);
        if (!cancelled) setPreview(pv);
      } catch (err) {
        if (!cancelled) {
          setLookupError(
            err.status === 404
              ? 'That invite link is not valid. Check that you copied the whole link.'
              : 'Could not check this invite link. Try again in a moment.',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!isReset && !email.trim()) return setError(EMAIL_REQUIRED_MESSAGE);
    if (!isReset && !isEmail(email)) return setError(EMAIL_INVALID_MESSAGE);
    if (password.length < MIN_PASSWORD)
      return setError(`Password must be at least ${MIN_PASSWORD} characters`);
    if (password !== confirm) return setError('Passwords do not match');

    setSubmitting(true);
    const result = await redeemInvite(code, {
      email: isReset ? undefined : email.trim(),
      // Blank lets the server default it to the email's local part.
      displayName: isReset ? undefined : displayName.trim() || undefined,
      password,
    });
    setSubmitting(false);

    if (result.success) {
      notifySuccess(
        isReset ? 'Your password has been changed.' : 'Your account is ready.',
        'Welcome',
      );
      navigate('/projects');
      return;
    }
    // 409 is the one failure worth rewording: the server says "already exists",
    // but the user's question is "what do I type instead".
    setError(
      result.status === 409
        ? 'An account already exists for that email address.'
        : result.error || 'Could not redeem this invite.',
    );
  };

  const deadMessage = preview && preview.status !== 'active' && DEAD_STATUS_MESSAGE[preview.status];

  return (
    <div className="tw flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <CardTitle className="text-2xl">
            {isReset ? 'Set a New Password' : 'Accept Your Invitation'}
          </CardTitle>
          <CardDescription>
            {loading
              ? 'Checking your invite…'
              : isReset
                ? `Choose a new password for ${preview.email}.`
                : preview?.projectName
                  ? `You have been invited to join ${preview.projectName} as a ${preview.projectRole}.`
                  : 'Choose an email address and password to get started.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-6">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
            </div>
          ) : lookupError || deadMessage ? (
            <div className="flex flex-col gap-4">
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {lookupError || deadMessage}
              </div>
              <Button asChild variant="outline" className="w-full">
                <Link to="/login">Go to sign in</Link>
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              {error && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {error}
                </div>
              )}

              {/* A maintainer testing their own link would otherwise be
                  silently swapped into a brand-new account, having spent one
                  of the invite's uses without noticing. Say so rather than
                  blocking it — testing the link is a legitimate reason to be
                  here signed in. */}
              {user && (
                <p className="rounded-md border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                  You are signed in as <strong>{user.displayName}</strong>.{' '}
                  {isReset
                    ? 'Setting this password will sign you out of that account.'
                    : 'Accepting this invitation creates a separate account and signs you out of that one.'}
                </p>
              )}

              {preview?.grantAdmin && (
                <p className="rounded-md border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                  This invitation grants administrator privileges.
                </p>
              )}

              {!isReset && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="invite-email">Your email address</Label>
                    <Input
                      id="invite-email"
                      type="email"
                      placeholder="e.g. jsmith@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={submitting}
                      autoComplete="email"
                      autoFocus
                    />
                    <p className="text-xs text-muted-foreground">
                      This is how you will sign in. It cannot be changed later.
                    </p>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="invite-display-name">Your name (optional)</Label>
                    <Input
                      id="invite-display-name"
                      placeholder="How you appear to your collaborators"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      disabled={submitting}
                      autoComplete="name"
                    />
                  </div>
                </>
              )}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="invite-password">
                  {isReset ? 'New password' : 'Choose a password'}
                </Label>
                <Input
                  id="invite-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                  autoComplete="new-password"
                  autoFocus={isReset}
                />
                <p className="text-xs text-muted-foreground">At least {MIN_PASSWORD} characters.</p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="invite-confirm">Confirm password</Label>
                <Input
                  id="invite-confirm"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={submitting}
                  autoComplete="new-password"
                />
              </div>

              <Button type="submit" disabled={submitting} className="mt-2 w-full">
                {submitting
                  ? 'Setting up…'
                  : isReset
                    ? 'Set password and sign in'
                    : 'Create account'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
