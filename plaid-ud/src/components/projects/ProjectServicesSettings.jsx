import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { RefreshCw, Trash2 } from 'lucide-react';
import { Badge } from '@ui/components/ui/badge';
import { Button } from '@ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';
import {
  TASKS,
  filterServicesByTask,
  servesTask,
  getParamSchema,
  buildDefaultValues,
} from '@larc-iu/plaid-client';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { ServiceParamForm } from '../editor/ServiceParamForm.jsx';
import { ServiceSummary } from '../editor/ServiceSummary.jsx';
import { notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { canManageProject } from '../../utils/permissions.js';
import {
  UD_NAMESPACE,
  encodeServiceSelection,
  decodeSelection,
  selectionFromConfig,
  selectionToConfig,
} from '../../utils/serviceDefaults.js';

// The app's service integration spots: each is a place in the UI where an
// external service can be plugged in, keyed by the task vocabulary services
// declare in their extras.
const SPOTS = [
  {
    key: TASKS.PARSE,
    label: 'Auto-parse',
    description:
      'Fills in lemmas, POS tags, features, and dependencies for a document ' +
      '(the "Auto Parse" button in the annotation editor).',
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
  const spotServices = useMemo(
    () => filterServicesByTask(services, spot.key),
    [services, spot.key],
  );
  const selection = selectionFromConfig(draftEntry) || 'none';
  const decoded = decodeSelection(selection);
  const selectedService =
    decoded?.kind === 'service'
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

  const radio = (value, node) => (
    <label className="flex cursor-pointer items-center gap-2">
      <input
        type="radio"
        className="h-4 w-4 cursor-pointer accent-primary"
        name={`spot-${spot.key}`}
        value={value}
        checked={selection === value}
        onChange={() => setSelection(value)}
        disabled={!canManage}
      />
      {node}
    </label>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{spot.label}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{spot.description}</p>

        {spot.builtins.length === 0 && spotServices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No service for this spot has ever connected to this project. Start one and it will
            appear here.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {radio('none', <span className="text-sm">No default (pick per use)</span>)}
            {spot.builtins.map((b) => (
              <div key={b.name} className="flex items-center gap-2">
                {radio(`builtin:${b.name}`, <span className="text-sm">{b.label}</span>)}
                <Badge variant="secondary">built-in</Badge>
              </div>
            ))}
            {spotServices.map((svc) => (
              <div key={svc.serviceId} className="flex flex-wrap items-center gap-2">
                {radio(
                  encodeServiceSelection(svc.serviceId),
                  <span className="text-sm">{svc.serviceName || svc.serviceId}</span>,
                )}
                <ServiceStatus service={svc} />
                <ServiceSummary service={svc} />
                {!svc.online && canManage && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive"
                    title="Forget this service (it reappears if it reconnects)"
                    aria-label={`Forget ${svc.serviceName || svc.serviceId}`}
                    onClick={() => onDiscard(svc.serviceId)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {selectedService && paramSchema.length > 0 && (
          <div className="rounded-md border bg-muted/40 p-3">
            <p className="mb-2 text-sm font-semibold">
              Default options for {selectedService.serviceName || selectedService.serviceId}
            </p>
            <ServiceParamForm
              schema={paramSchema}
              values={paramValues}
              onChange={setParam}
              disabled={!canManage}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// A service's online badge, plus when it was last seen if it is not.
function ServiceStatus({ service }) {
  return (
    <>
      <Badge
        variant="outline"
        className={
          service.online
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700'
            : 'border-border bg-muted text-muted-foreground'
        }
      >
        {service.online ? 'online' : 'offline'}
      </Badge>
      {!service.online && (
        <span className="text-xs text-muted-foreground">{lastSeenText(service)}</span>
      )}
    </>
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

  useEffect(() => {
    load();
  }, [load]);

  // The online/offline picture goes stale while the tab is hidden; refresh on return.
  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) load();
    };
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
    return <p className="tw p-4 text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="tw flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-xl text-sm text-muted-foreground">
          Services that have connected to this project are remembered here, online or not. Set a
          default (and default options) for each spot; people can still switch per use.
        </p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      {!canManage && project && (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          You can view this registry. Only project maintainers can change defaults.
        </p>
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
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Other services</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              Seen on this project, but not used by any spot in this app.
            </p>
            {unmatched.map((svc) => (
              <div key={svc.serviceId} className="flex flex-wrap items-center gap-2">
                <span className="text-sm">{svc.serviceName || svc.serviceId}</span>
                <ServiceStatus service={svc} />
                <ServiceSummary service={svc} />
                {!svc.online && canManage && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive"
                    aria-label={`Forget ${svc.serviceName || svc.serviceId}`}
                    onClick={() => discard(svc.serviceId)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {canManage && (
        <div>
          <Button onClick={save} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save defaults'}
          </Button>
        </div>
      )}
    </div>
  );
};
