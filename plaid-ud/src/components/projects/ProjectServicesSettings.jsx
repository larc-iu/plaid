import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import {
  Stack, Group, Text, Title, Button, Badge, Radio, ActionIcon, Paper, Alert, Tooltip, Loader,
} from '@mantine/core';
import IconRefresh from '@tabler/icons-react/dist/esm/icons/IconRefresh.mjs';
import IconTrash from '@tabler/icons-react/dist/esm/icons/IconTrash.mjs';
import {
  TASKS, filterServicesByTask, servesTask, getParamSchema, buildDefaultValues,
} from '@larc-iu/plaid-client';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { ServiceParamForm } from '../editor/ServiceParamForm.jsx';
import { ServiceSummary } from '../editor/ServiceSummary.jsx';
import { notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { canManageProject } from '../../utils/permissions.js';
import {
  UD_NAMESPACE, encodeServiceSelection, decodeSelection, selectionFromConfig, selectionToConfig,
} from '../../utils/serviceDefaults.js';

// The app's service integration spots: each is a place in the UI where an
// external service can be plugged in, keyed by the task vocabulary services
// declare in their extras.
const SPOTS = [
  {
    key: TASKS.PARSE,
    label: 'Auto-parse',
    description: 'Fills in lemmas, POS tags, features, and dependencies for a document '
      + '(the "Auto Parse" button in the annotation editor).',
    builtins: [],
  },
];

const lastSeenText = (svc) => {
  if (!svc.lastSeenAt) return 'never seen online';
  try {
    return `last seen ${new Date(svc.lastSeenAt).toLocaleString()}`;
  } catch {
    return `last seen ${svc.lastSeenAt}`;
  }
};

// One spot's card: every service ever seen for its task (online or not) plus
// any app built-ins, a default selection, and default parameter values for the
// selected default service.
function SpotCard({ spot, services, draftEntry, onChange, canManage, onDiscard }) {
  const spotServices = useMemo(() => filterServicesByTask(services, spot.key), [services, spot.key]);
  const selection = selectionFromConfig(draftEntry) || 'none';
  const decoded = decodeSelection(selection);
  const selectedService = decoded?.kind === 'service'
    ? spotServices.find((s) => s.serviceId === decoded.id) || null
    : null;
  const paramSchema = getParamSchema(selectedService);
  const paramValues = useMemo(
    () => ({ ...buildDefaultValues(paramSchema), ...(draftEntry?.params || {}) }),
    [paramSchema, draftEntry],
  );

  const setSelection = (value) => {
    const service = selectionToConfig(value);
    onChange(service ? { service, params: {} } : null);
  };
  const setParam = (key, value) => {
    onChange({ ...(draftEntry || {}), params: { ...paramValues, [key]: value } });
  };

  return (
    <Paper withBorder p="md">
      <Title order={4}>{spot.label}</Title>
      <Text size="sm" c="dimmed" mb="sm">{spot.description}</Text>

      {spot.builtins.length === 0 && spotServices.length === 0 ? (
        <Text size="sm" c="dimmed">
          No service for this spot has ever connected to this project. Start one and it will appear here.
        </Text>
      ) : (
        <Radio.Group value={selection} onChange={setSelection}>
          <Stack gap="xs">
            <Radio value="none" label={<Text size="sm" span>No default (pick per use)</Text>} disabled={!canManage} />
            {spot.builtins.map((b) => (
              <Group key={b.name} gap="xs" wrap="nowrap">
                <Radio
                  value={`builtin:${b.name}`}
                  label={<Text size="sm" span>{b.label}</Text>}
                  disabled={!canManage}
                />
                <Badge size="sm" variant="light" color="blue">built-in</Badge>
              </Group>
            ))}
            {spotServices.map((svc) => (
              <Group key={svc.serviceId} gap="xs" wrap="nowrap">
                <Radio
                  value={encodeServiceSelection(svc.serviceId)}
                  label={<Text size="sm" span>{svc.serviceName || svc.serviceId}</Text>}
                  disabled={!canManage}
                />
                {svc.online
                  ? <Badge size="sm" variant="light" color="green">online</Badge>
                  : <Badge size="sm" variant="light" color="gray">offline</Badge>}
                {!svc.online && (
                  <Text size="xs" c="dimmed">{lastSeenText(svc)}</Text>
                )}
                <ServiceSummary service={svc} />
                {!svc.online && canManage && (
                  <Tooltip label="Forget this service (it reappears if it reconnects)">
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={`Forget ${svc.serviceName || svc.serviceId}`}
                      onClick={() => onDiscard(svc.serviceId)}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </Group>
            ))}
          </Stack>
        </Radio.Group>
      )}

      {selectedService && paramSchema.length > 0 && (
        <Paper withBorder p="sm" mt="md" bg="gray.0">
          <Text size="sm" fw={600} mb="xs">Default options for {selectedService.serviceName || selectedService.serviceId}</Text>
          <ServiceParamForm
            schema={paramSchema}
            values={paramValues}
            onChange={setParam}
            disabled={!canManage}
          />
        </Paper>
      )}
    </Paper>
  );
}

// Project-level Services settings: a registry of every service ever seen on
// this project (online/offline), one card per integration spot, with a
// maintainer-settable default service + default parameters per spot. Defaults
// are stored in config.ud.serviceDefaults; editors seed from them (per-user
// localStorage still overrides).
export const ProjectServicesSettings = () => {
  const { projectId } = useParams();
  const { getClient, user } = useAuth();
  const [project, setProject] = useState(null);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const canManage = canManageProject(project, user);

  const load = useCallback(async () => {
    const client = getClient();
    if (!client) return;
    setLoading(true);
    try {
      const [p, svcs] = await Promise.all([
        client.projects.get(projectId),
        client.messages.discoverServices(projectId),
      ]);
      setProject(p);
      setServices(svcs || []);
      setDraft(p?.config?.[UD_NAMESPACE]?.serviceDefaults || {});
      setDirty(false);
    } catch (error) {
      notifyError(error.message || 'Failed to load services', 'Services');
    } finally {
      setLoading(false);
    }
  }, [projectId, getClient]);

  useEffect(() => { load(); }, [load]);

  // The online/offline picture goes stale while the tab is hidden; refresh on return.
  useEffect(() => {
    const onVisibility = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [load]);

  const setSpotEntry = (task, entry) => {
    setDraft((prev) => {
      const next = { ...prev };
      if (entry) next[task] = entry;
      else delete next[task];
      return next;
    });
    setDirty(true);
  };

  const save = async () => {
    const client = getClient();
    if (!client) return;
    setSaving(true);
    try {
      await client.projects.setConfig(projectId, UD_NAMESPACE, 'serviceDefaults', draft);
      setDirty(false);
      notifySuccess('Service defaults saved');
    } catch (error) {
      notifyError(error.message || 'Failed to save service defaults', 'Services');
    } finally {
      setSaving(false);
    }
  };

  const discard = async (serviceId) => {
    const client = getClient();
    if (!client) return;
    try {
      await client.messages.discardService(projectId, serviceId);
      await load();
    } catch (error) {
      notifyError(error.message || 'Failed to forget service', 'Services');
    }
  };

  // Seen services that match none of this app's spots would otherwise be
  // invisible (and undeletable); surface them so the registry stays tidy.
  const unmatched = useMemo(
    () => services.filter((s) => !SPOTS.some((spot) => servesTask(s, spot.key))),
    [services],
  );

  if (loading && !project) {
    return <Group justify="center" py="xl"><Loader size="sm" /></Group>;
  }

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Text size="sm" c="dimmed" maw={560}>
          Services that have connected to this project are remembered here, online or not.
          Set a default (and default options) for each spot; people can still switch per use.
        </Text>
        <Button
          variant="default"
          size="xs"
          leftSection={<IconRefresh size={14} />}
          onClick={load}
          loading={loading}
        >
          Refresh
        </Button>
      </Group>

      {!canManage && project && (
        <Alert color="gray" variant="light" py="xs">
          You can view this registry, but only project maintainers can change defaults.
        </Alert>
      )}

      {SPOTS.map((spot) => (
        <SpotCard
          key={spot.key}
          spot={spot}
          services={services}
          draftEntry={draft[spot.key] || null}
          onChange={(entry) => setSpotEntry(spot.key, entry)}
          canManage={canManage}
          onDiscard={discard}
        />
      ))}

      {unmatched.length > 0 && (
        <Paper withBorder p="md">
          <Title order={4}>Other services</Title>
          <Text size="sm" c="dimmed" mb="sm">
            Seen on this project, but not used by any spot in this app.
          </Text>
          <Stack gap="xs">
            {unmatched.map((svc) => (
              <Group key={svc.serviceId} gap="xs" wrap="nowrap">
                <Text size="sm">{svc.serviceName || svc.serviceId}</Text>
                {svc.online
                  ? <Badge size="sm" variant="light" color="green">online</Badge>
                  : <Badge size="sm" variant="light" color="gray">offline</Badge>}
                {!svc.online && <Text size="xs" c="dimmed">{lastSeenText(svc)}</Text>}
                <ServiceSummary service={svc} />
                {!svc.online && canManage && (
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={`Forget ${svc.serviceName || svc.serviceId}`}
                    onClick={() => discard(svc.serviceId)}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                )}
              </Group>
            ))}
          </Stack>
        </Paper>
      )}

      {canManage && (
        <Group>
          <Button onClick={save} loading={saving} disabled={!dirty}>Save defaults</Button>
        </Group>
      )}
    </Stack>
  );
};
