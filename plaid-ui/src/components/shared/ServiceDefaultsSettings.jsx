import { useState, useEffect, useCallback, useMemo } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import {
  filterServicesByTask,
  servesTask,
  getParamSchema,
  buildDefaultValues,
} from '@larc-iu/plaid-client';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { ServiceParamForm } from '../services/ServiceParamForm.jsx';
import { ServiceSummary } from '../services/ServiceSummary.jsx';
import { notifySuccess, notifyError } from '../../lib/notify.js';
import { humanizeError } from '../../lib/errors.js';
import { useLatestCall } from '../../hooks/useLatestCall.js';
import { configNamespace } from '../../lib/uiConfig.js';
import {
  encodeServiceSelection,
  encodeBuiltinSelection,
  decodeSelection,
  selectionFromConfig,
  selectionToConfig,
} from '../../domain/serviceDefaults.js';

const lastSeenText = (svc) => {
  if (!svc.lastSeenAt) return 'never seen online';
  try {
    return `last seen ${new Date(svc.lastSeenAt).toLocaleString()}`;
  } catch {
    return `last seen ${svc.lastSeenAt}`;
  }
};

/** Whether a service is reachable, and when it last was if it is not. */
const ServiceStatus = ({ service }) => (
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

/** Forget a service that is not currently connected. */
const ForgetButton = ({ service, onDiscard }) => (
  <Button
    variant="ghost"
    size="icon"
    className="h-7 w-7 text-muted-foreground hover:text-destructive"
    title="Forget this service. It reappears if it reconnects."
    aria-label={`Forget ${service.serviceName || service.serviceId}`}
    onClick={() => onDiscard(service.serviceId)}
  >
    <Trash2 className="h-4 w-4" />
  </Button>
);

// One selectable row (a built-in or a service) within a spot card.
function OptionRow({ spotKey, value, label, checked, onSelect, disabled, badge, children }) {
  const id = `svc-default-${spotKey}-${value}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="radio"
        id={id}
        name={`svc-default-${spotKey}`}
        className="h-4 w-4 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={() => onSelect(value)}
      />
      <label htmlFor={id} className="cursor-pointer text-sm">
        {label}
      </label>
      {badge}
      {children}
    </div>
  );
}

// One spot's card: every service ever seen for its task (online or not) plus
// any app built-ins, a default selection, and default parameter values for the
// selected default service.
function SpotCard({ spot, services, draftEntry, onChange, onDiscard, canManage, builtinOptions }) {
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
  // A selected built-in may carry its own options (the link rule's copy policy,
  // say), shown in the same inline slot a service's params use.
  const builtinOpts = decoded?.kind === 'builtin' ? builtinOptions?.(spot.key, decoded.id) : null;
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
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{spot.label}</CardTitle>
        <CardDescription>{spot.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {spot.builtins.length === 0 && spotServices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No service for this spot has connected to this project. Start one to see it here.
          </p>
        ) : (
          <div className="space-y-2">
            <OptionRow
              spotKey={spot.key}
              value="none"
              label="No default (pick per use)"
              checked={selection === 'none'}
              onSelect={setSelection}
              disabled={!canManage}
            />
            {spot.builtins.map((b) => (
              <OptionRow
                key={b.name}
                spotKey={spot.key}
                value={encodeBuiltinSelection(b.name)}
                label={b.label}
                checked={selection === encodeBuiltinSelection(b.name)}
                onSelect={setSelection}
                disabled={!canManage}
                badge={<Badge variant="secondary">built-in</Badge>}
              />
            ))}
            {spotServices.map((svc) => (
              <OptionRow
                key={svc.serviceId}
                spotKey={spot.key}
                value={encodeServiceSelection(svc.serviceId)}
                label={svc.serviceName || svc.serviceId}
                checked={selection === encodeServiceSelection(svc.serviceId)}
                onSelect={setSelection}
                disabled={!canManage}
                badge={<ServiceStatus service={svc} />}
              >
                <ServiceSummary service={svc} />
                {!svc.online && canManage && <ForgetButton service={svc} onDiscard={onDiscard} />}
              </OptionRow>
            ))}
          </div>
        )}

        {builtinOpts && <div className="mt-3 border-t pt-3">{builtinOpts}</div>}
        {selectedService && paramSchema.length > 0 && (
          <div className="mt-3 border-t pt-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
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

/**
 * A project's service registry: every service ever seen on it, online or not,
 * one card per integration spot, with a default service and default parameters
 * per spot. Defaults are stored under the app's own `configNamespace`, and an
 * editor seeds from them (a per-user localStorage choice still wins).
 *
 * `spots` is the app's, being a list of places in its own UI. `builtinOptions`
 * lets a selected built-in show options of its own, and `saveExtra` lets the
 * app write a second config key in the same Save, clearing its own `extraDirty`
 * once that write has landed.
 */
export const ServiceDefaultsSettings = ({
  projectId,
  client,
  spots,
  canManage = true,
  builtinOptions,
  onProjectLoaded,
  extraDirty = false,
  saveExtra,
}) => {
  const namespace = configNamespace();
  const [project, setProject] = useState(null);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const begin = useLatestCall();
  const load = useCallback(async () => {
    if (!client) return;
    // The project can change under this screen, and a discovery is slow enough
    // that the project just left can answer last.
    const isCurrent = begin();
    setLoading(true);
    try {
      const [p, svcs] = await Promise.all([
        client.projects.get(projectId),
        client.messages.discoverServices(projectId),
      ]);
      if (!isCurrent()) return;
      setProject(p);
      setServices(svcs || []);
      setDraft(p?.config?.[namespace]?.serviceDefaults || {});
      onProjectLoaded?.(p);
      setDirty(false);
    } catch (error) {
      if (!isCurrent()) return;
      notifyError(humanizeError(error), 'Could not load the services');
    } finally {
      if (isCurrent()) setLoading(false);
    }
    // `onProjectLoaded` is the app's and is redefined every render; naming it
    // here would reload on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, client, begin, namespace]);

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
    if (!client) return;
    setSaving(true);
    try {
      await client.projects.setConfig(projectId, namespace, 'serviceDefaults', draft);
      await saveExtra?.();
      setDirty(false);
      notifySuccess('Service defaults saved');
    } catch (error) {
      notifyError(humanizeError(error), 'Could not save the defaults');
    } finally {
      setSaving(false);
    }
  };

  const discard = async (serviceId) => {
    if (!client) return;
    try {
      await client.messages.discardService(projectId, serviceId);
      await load();
    } catch (error) {
      notifyError(humanizeError(error), 'Could not forget the service');
    }
  };

  // Seen services that match none of this app's spots would otherwise be
  // invisible (and undeletable); surface them so the registry stays tidy.
  const unmatched = useMemo(
    () => services.filter((s) => !spots.some((spot) => servesTask(s, spot.key))),
    [services, spots],
  );

  if (loading && !project) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-xl text-sm text-muted-foreground">
          Services that have connected to this project are remembered here, online or not. Set a
          default and default options for each spot.
        </p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {!canManage && (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Read-only. Only project maintainers can change defaults.
        </p>
      )}

      {spots.map((spot) => (
        <SpotCard
          key={spot.key}
          spot={spot}
          services={services}
          draftEntry={draft[spot.key] || null}
          onChange={(entry) => setSpotEntry(spot.key, entry)}
          onDiscard={discard}
          canManage={canManage}
          builtinOptions={builtinOptions}
        />
      ))}

      {unmatched.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Other services</CardTitle>
            <CardDescription>
              Seen on this project, but not used by any spot in this app.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {unmatched.map((svc) => (
              <div key={svc.serviceId} className="flex flex-wrap items-center gap-2">
                <span className="text-sm">{svc.serviceName || svc.serviceId}</span>
                <ServiceStatus service={svc} />
                <ServiceSummary service={svc} />
                {!svc.online && canManage && <ForgetButton service={svc} onDiscard={discard} />}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Button onClick={save} disabled={(!dirty && !extraDirty) || saving}>
          {saving ? 'Saving…' : 'Save defaults'}
        </Button>
      )}
    </div>
  );
};
