import { useState, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import {
  Center,
  Stack,
  Paper,
  Title,
  Text,
  TextInput,
  PasswordInput,
  Button,
  Alert,
  Loader,
} from '@mantine/core';
import { useAuth } from '../../contexts/AuthContext';
import { authService } from '../../services/auth';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { isEmail, EMAIL_REQUIRED_MESSAGE, EMAIL_INVALID_MESSAGE } from '../../utils/email';

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

  const subtitle = loading
    ? 'Checking your invite…'
    : isReset
      ? `Choose a new password for ${preview.email}.`
      : preview?.projectName
        ? `You have been invited to join ${preview.projectName} as a ${preview.projectRole}.`
        : 'Choose an email address and password to get started.';

  return (
    <Center mih="100vh" bg="gray.0" p="md">
      <Stack w="100%" maw={400} gap="xl">
        <div>
          <Title order={1} ta="center">
            {isReset ? 'Set a New Password' : 'Accept Your Invitation'}
          </Title>
          <Text c="dimmed" ta="center" size="sm" mt="xs">
            {subtitle}
          </Text>
        </div>

        <Paper withBorder shadow="sm" p="xl" radius="md">
          {loading ? (
            <Center py="md">
              <Loader size="sm" />
            </Center>
          ) : lookupError || deadMessage ? (
            <Stack gap="md">
              <Alert color="red">{lookupError || deadMessage}</Alert>
              <Button component={Link} to="/login" variant="default" fullWidth>
                Go to sign in
              </Button>
            </Stack>
          ) : (
            <form onSubmit={handleSubmit}>
              <Stack gap="md">
                {error && <Alert color="red">{error}</Alert>}

                {/* A maintainer testing their own link would otherwise be
                    silently swapped into a brand-new account, having spent one
                    of the invite's uses without noticing. Say so rather than
                    blocking it — testing the link is a legitimate reason to be
                    here signed in. */}
                {user && (
                  <Alert color="yellow" variant="light">
                    You are signed in as <strong>{user.displayName}</strong>.{' '}
                    {isReset
                      ? 'Setting this password will sign you out of that account.'
                      : 'Accepting this invitation creates a separate account and signs you out of that one.'}
                  </Alert>
                )}

                {preview?.grantAdmin && (
                  <Alert color="blue" variant="light">
                    This invitation grants administrator privileges.
                  </Alert>
                )}

                {!isReset && (
                  <>
                    <TextInput
                      label="Your email address"
                      description="This is how you will sign in. It cannot be changed later."
                      type="email"
                      placeholder="e.g. jsmith@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={submitting}
                      autoComplete="email"
                      data-autofocus
                      required
                    />

                    <TextInput
                      label="Your name (optional)"
                      description="How you appear to your collaborators."
                      placeholder="e.g. Jane Smith"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      disabled={submitting}
                      autoComplete="name"
                    />
                  </>
                )}

                <PasswordInput
                  label={isReset ? 'New password' : 'Choose a password'}
                  description={`At least ${MIN_PASSWORD} characters.`}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                  autoComplete="new-password"
                  required
                />

                <PasswordInput
                  label="Confirm password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={submitting}
                  autoComplete="new-password"
                  required
                />

                <Button type="submit" loading={submitting} fullWidth>
                  {isReset ? 'Set password and sign in' : 'Create account'}
                </Button>
              </Stack>
            </form>
          )}
        </Paper>
      </Stack>
    </Center>
  );
};
