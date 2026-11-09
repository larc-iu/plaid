import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/useAuth.js';
import { authService } from '../../services/auth.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { usePasswordMinimum, passwordTooShort } from '../../hooks/usePasswordMinimum.js';
import { notifySuccess } from '../../lib/notify.js';
import { humanizeError, statusOf } from '../../lib/errors.js';
import { appName } from '../../lib/uiConfig.js';
import { isEmail, EMAIL_REQUIRED_MESSAGE, EMAIL_INVALID_MESSAGE } from '../../lib/email.js';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card';
import { Loading } from '../shared/Loading.jsx';
import { TYPE } from '../../lib/typeScale.js';

// Why a code can be dead, in the words the holder needs. The server sends the
// status because the holder already has the code: there is nothing left to
// withhold, and "invalid" alone leaves them with no idea what to do next.
const DEAD_STATUS_MESSAGE = {
  used: 'This invite has already been used. Ask whoever sent it for a new link.',
  expired: 'This invite has expired. Ask whoever sent it for a new link.',
  revoked: 'This invite has been revoked. Ask whoever sent it for a new link.',
  // Its creator lost the access it grants, so they are the wrong person to ask.
  inactive: (preview) =>
    preview.projectName
      ? `This invite no longer works. Ask a maintainer of ${preview.projectName} for a new link.`
      : 'This invite no longer works. Ask an administrator for a new link.',
};

const deadMessageFor = (preview) => {
  if (!preview || preview.status === 'active') return null;
  const message = DEAD_STATUS_MESSAGE[preview.status];
  return typeof message === 'function' ? message(preview) : message;
};

/**
 * Accept an invitation, or set a new password from an admin-issued reset link.
 *
 * `loginPath` and `homePath` are the app's, for the same reason
 * `createProtectedRoute` takes its `loginPath`: a routing table is an app's own.
 * `projectPath(id)` is where the app opens a project, for an invite that
 * joined one.
 */
export const RedeemInvite = ({ loginPath, homePath, projectPath }) => {
  const { code } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { redeemInvite, user, client } = useAuth();
  // Stated up front rather than only on rejection: this is the one password
  // the user will have to remember.
  const passwordMinimum = usePasswordMinimum();

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
  // A link into a project, which an account that exists can take too. One that
  // makes an administrator is for a new account only.
  const joinable = !isReset && !!preview?.projectName && !preview?.grantAdmin;
  const [joining, setJoining] = useState(false);
  useDocumentTitle(isReset ? 'Set a new password' : 'Accept invitation');

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
              : 'Failed to check this invite link. Try again in a moment.',
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
    const tooShort = passwordTooShort(password, passwordMinimum);
    if (tooShort) return setError(tooShort);
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
      navigate(result.projectId && projectPath ? projectPath(result.projectId) : homePath);
      return;
    }
    // 409 is the one failure worth rewording: the server says "already exists",
    // but the user's question is "what do I type instead".
    setError(
      result.status === 409
        ? joinable
          ? `An account already exists for that email address. Sign in to join ${preview.projectName}.`
          : 'An account already exists for that email address.'
        : result.error || 'Failed to redeem this invite.',
    );
  };

  // The signed-in account joins the project. A link that turned out dead says
  // why, as the lookup would have.
  const join = async () => {
    setError('');
    setJoining(true);
    try {
      const joined = await client.invites.accept(code);
      if (joined.joined) {
        notifySuccess(`Joined ${preview.projectName} as a ${joined.projectRole}.`, 'Welcome');
      }
      navigate(projectPath ? projectPath(joined.projectId) : homePath);
    } catch (err) {
      const status = err?.responseData?.status;
      if (statusOf(err) === 410 && status) setPreview((pv) => ({ ...pv, status }));
      else setError(humanizeError(err, 'Failed to join the project.'));
      setJoining(false);
    }
  };

  // Back from "Sign in to join": join straight away, once.
  const joinedOnArrival = useRef(false);
  useEffect(() => {
    if (!user || !joinable || preview?.status !== 'active') return;
    if (!location.state?.signedIn || joinedOnArrival.current) return;
    joinedOnArrival.current = true;
    join();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, joinable, preview?.status, location.state]);

  const deadMessage = deadMessageFor(preview);

  const subtitle = loading
    ? 'Checking your invite…'
    : isReset
      ? `Choose a new password for ${preview.email}.`
      : preview?.projectName
        ? `You have been invited to join ${preview.projectName} as a ${preview.projectRole}.`
        : 'Choose an email address and password.';

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <CardTitle className={TYPE.page}>
            {isReset ? 'Set a new password' : 'Accept your invitation'}
          </CardTitle>
          <CardDescription>{subtitle}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Loading className="py-6 text-center" />
          ) : lookupError || deadMessage ? (
            <div className="flex flex-col gap-4">
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {lookupError || deadMessage}
              </div>
              <Button asChild variant="outline" className="w-full">
                {user ? (
                  <Link to={homePath}>Open {appName()}</Link>
                ) : (
                  <Link to={loginPath}>Go to sign in</Link>
                )}
              </Button>
            </div>
          ) : user && joinable ? (
            <div className="flex flex-col gap-4">
              {error && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {error}
                </div>
              )}
              <p className="text-sm text-muted-foreground">
                Signed in as <strong>{user.displayName}</strong>.
              </p>
              <Button onClick={join} disabled={joining} className="w-full">
                {joining ? 'Joining…' : `Join ${preview.projectName}`}
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
                  blocking it: testing the link is a legitimate reason to be
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
                      type="text"
                      inputMode="email"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="e.g. jsmith@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={submitting}
                      autoComplete="username"
                      autoFocus
                    />
                    <p className="text-xs text-muted-foreground">
                      Your sign-in address. It cannot be changed later.
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
                {passwordMinimum && (
                  <p className="text-xs text-muted-foreground">
                    At least {passwordMinimum} characters.
                  </p>
                )}
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

              {joinable && (
                <Button asChild variant="outline" className="w-full">
                  <Link to={loginPath} state={{ from: `/invite/${code}` }}>
                    Sign in to join {preview.projectName}
                  </Link>
                </Button>
              )}
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
