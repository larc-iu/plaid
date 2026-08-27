import { useState, useEffect, useCallback } from 'react';
import {
  Paper,
  Group,
  Title,
  Text,
  Button,
  Table,
  Badge,
  Center,
  Loader,
  Modal,
  Stack,
  TextInput,
  NumberInput,
  Select,
  ActionIcon,
  CopyButton,
  Tooltip,
} from '@mantine/core';
import { IconLink, IconCopy, IconCheck, IconTrash } from '@tabler/icons-react';
import PlaidClient from '@larc-iu/plaid-client';
import { notifySuccess, notifyError, confirmDelete } from '../../utils/feedback.jsx';

const GRANT_ROLES = [
  { value: 'reader', label: 'Reader' },
  { value: 'writer', label: 'Writer' },
  { value: 'maintainer', label: 'Maintainer' },
];

const STATUS_COLOR = { active: 'green', used: 'gray', expired: 'gray', revoked: 'red' };

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
};

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

// The server never learns the app's public URL, so the app that minted the
// invite is the one that names it. `window.location` is authoritative here in a
// way no server config could be: it is literally where this user is.
export const inviteLinkFor = (code) => {
  const { origin, pathname } = window.location;
  return PlaidClient.inviteUrl(`${origin}${pathname}`, code);
};

// Shown once, immediately after minting. The code is not stored anywhere and
// the server cannot produce it again, so this modal is the only chance to
// capture it — hence the copy button and the explicit warning.
export const MintedLinkModal = ({ code, onClose, title = 'Invitation link created' }) => {
  const link = code ? inviteLinkFor(code) : '';
  return (
    <Modal opened={!!code} onClose={onClose} title={title} size="lg">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Copy this link now. It is not stored, so it cannot be shown again — if you lose it, revoke
          this invite and create another.
        </Text>
        <Group gap="xs" wrap="nowrap">
          <TextInput
            readOnly
            value={link}
            style={{ flex: 1 }}
            styles={{ input: { fontFamily: 'monospace', fontSize: 12 } }}
            onFocus={(e) => e.target.select()}
          />
          <CopyButton value={link} timeout={2000}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? 'Copied' : 'Copy link'} withArrow>
                <ActionIcon
                  variant="default"
                  size="lg"
                  onClick={copy}
                  aria-label="Copy invite link"
                >
                  {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        </Group>
        <Group justify="flex-end">
          <Button onClick={onClose}>Done</Button>
        </Group>
      </Stack>
    </Modal>
  );
};

export const ProjectInvites = ({ projectId, projectName, client, canManage }) => {
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [role, setRole] = useState('writer');
  const [maxUses, setMaxUses] = useState(1);
  const [ttlDays, setTtlDays] = useState(14);
  const [note, setNote] = useState('');
  const [creating, setCreating] = useState(false);
  const [mintedCode, setMintedCode] = useState(null);

  const load = useCallback(async () => {
    if (!canManage) return;
    try {
      setLoading(true);
      setInvites((await client.invites.list({ projectId })) || []);
    } catch (err) {
      console.error('Error loading invites:', err);
      notifyError('Failed to load invitation links');
    } finally {
      setLoading(false);
    }
  }, [client, projectId, canManage]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    try {
      setCreating(true);
      const inv = await client.invites.create({
        projectId,
        projectRole: role,
        maxUses,
        ttlDays,
        note: note.trim() || undefined,
      });
      setCreateOpen(false);
      setNote('');
      setMintedCode(inv.code);
      await load();
    } catch (err) {
      console.error('Error creating invite:', err);
      notifyError(err.message || 'Failed to create invitation link');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = (inv) => {
    confirmDelete({
      title: 'Revoke this invitation link?',
      message:
        'The link stops working immediately. Anyone who already used it keeps their account and access.',
      confirmLabel: 'Revoke link',
      onConfirm: async () => {
        try {
          await client.invites.revoke(inv.id);
          notifySuccess('Invitation link revoked');
          await load();
        } catch (err) {
          console.error('Error revoking invite:', err);
          notifyError('Failed to revoke invitation link');
        }
      },
    });
  };

  if (!canManage) return null;

  return (
    <Paper withBorder radius="md" mb="lg">
      <Group
        px="lg"
        py="md"
        justify="space-between"
        style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}
      >
        <div>
          <Title order={3} size="h4">
            Invitation links
          </Title>
          <Text size="sm" c="dimmed">
            Send someone a link instead of a password. They choose their own credentials and join{' '}
            {projectName || 'this project'} automatically.
          </Text>
        </div>
        <Button size="sm" leftSection={<IconLink size={16} />} onClick={() => setCreateOpen(true)}>
          New link
        </Button>
      </Group>

      {loading ? (
        <Center py="xl">
          <Loader size="sm" />
        </Center>
      ) : invites.length === 0 ? (
        <Text px="lg" py="md" size="sm" c="dimmed">
          No invitation links yet. Create one to onboard someone without sending a password.
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={620}>
          <Table verticalSpacing="sm" horizontalSpacing="lg">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Label</Table.Th>
                <Table.Th>Grants</Table.Th>
                <Table.Th>Used</Table.Th>
                <Table.Th>Expires</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th w={48} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {invites.map((inv) => (
                <Table.Tr key={inv.id}>
                  <Table.Td>
                    {inv.note || (
                      <Text span size="sm" c="dimmed" fs="italic">
                        Untitled
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>{cap(inv.projectRole)}</Table.Td>
                  <Table.Td>
                    {inv.uses} / {inv.maxUses}
                  </Table.Td>
                  <Table.Td>{fmtDate(inv.expiresAt)}</Table.Td>
                  <Table.Td>
                    <Badge color={STATUS_COLOR[inv.status] || 'gray'} variant="light">
                      {inv.status}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {inv.status === 'active' && (
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label="Revoke invitation link"
                        onClick={() => handleRevoke(inv)}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      <Modal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New invitation link"
        size="md"
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Anyone with the link can create one account and join this project.
          </Text>
          <Select label="They join as" data={GRANT_ROLES} value={role} onChange={setRole} />
          <Group grow align="flex-start">
            <NumberInput
              label="Number of uses"
              description="Raise this to share one link with a whole class."
              min={1}
              value={maxUses}
              onChange={setMaxUses}
            />
            <NumberInput label="Expires in (days)" min={1} value={ttlDays} onChange={setTtlDays} />
          </Group>
          <TextInput
            label="Label (optional)"
            description="Only you see this. It is how you will recognize the link later."
            placeholder="e.g. Fall 2026 field methods"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={handleCreate} loading={creating}>
              Create link
            </Button>
          </Group>
        </Stack>
      </Modal>

      <MintedLinkModal code={mintedCode} onClose={() => setMintedCode(null)} />
    </Paper>
  );
};
