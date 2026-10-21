import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import {
  filterServicesByTask,
  servesTask,
  getParamSchema,
  buildDefaultValues,
  CONFIDENCE_KEY,
  PLAID_NAMESPACE,
  readConfidenceThreshold,
} from '@larc-iu/plaid-client';
import { resolveFieldParams } from '../../domain/serviceFields.js';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { ServiceParamForm } from '../services/ServiceParamForm.jsx';
import { ServiceSummary } from '../services/ServiceSummary.jsx';
import { Loading } from './Loading.jsx';
import { notifySuccess, notifyError } from '../../lib/notify.js';
import { humanizeError } from '../../lib/errors.js';
import {
  expectStored,
  isConfigConflict,
  sameConfig,
  storedConfig,
} from '../../domain/configCells.js';
import { useLatestCall } from '../../hooks/useLatestCall.js';
import { configNamespace } from '../../lib/uiConfig.js';
import {
  encodeServiceSelection,
  encodeBuiltinSelection,
  decodeSelection,
  fieldParamNames,
  fieldParamsOf,
  selectionFromConfig,
  selectionToConfig,
} from '../../domain/serviceDefaults.js';

// The threshold as the field shows it, a whole percentage.
const thresholdText = (config) => String(Math.round(readConfidenceThreshold(config) * 100));
// The field's text as a stored threshold, or null when it is not a whole
// number from 0 to 100.
const parseThreshold = (text) => {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n <= 100 ? n / 100 : null;
};

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
          ? 'border-success/40 bg-success/10 text-success-foreground'
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
function SpotCard({
  spot,
  services,
  draftEntry,
  onChange,
  onDiscard,
  canManage,
  builtinOptions,
  fields,
  fieldRoles,
  fieldIds,
}) {
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
  // A service's own options. Its field parameters are the task's default
  // fields, below, shared by every method of the task.
  const paramSchema = useMemo(
    () => getParamSchema(selectedService).filter((p) => p?.type !== 'field'),
    [selectedService],
  );
  // Only the keys of those options: a field parameter is never kept by name
  // in `params`, so saving drops one an older setting left there.
  const paramValues = useMemo(() => {
    const stored = draftEntry?.params || {};
    return Object.fromEntries(
      paramSchema.map((p) => [p.key, stored[p.key] ?? buildDefaultValues([p])[p.key]]),
    );
  }, [paramSchema, draftEntry]);
  // Every field parameter the task's methods take, once per key.
  const fieldSchema = useMemo(() => {
    const byKey = new Map();
    for (const svc of spotServices) {
      for (const p of getParamSchema(svc)) {
        if (p?.type === 'field' && p.key && !byKey.has(p.key)) {
          byKey.set(p.key, { ...p, default: '', required: false });
        }
      }
    }
    return [...byKey.values()];
  }, [spotServices]);
  // As the run dialog seeds them: a stored default field, else the one field
  // holding the parameter's role.
  const fieldValues = useMemo(
    () =>
      resolveFieldParams(
        fieldSchema,
        {
          ...Object.fromEntries(fieldSchema.map((p) => [p.key, ''])),
          ...fieldParamNames(draftEntry, fieldIds),
        },
        fields,
        fieldRoles,
      ),
    [fieldSchema, draftEntry, fields, fieldRoles, fieldIds],
  );
  const fieldParams = fieldParamsOf(draftEntry);
  const hasFields = Object.keys(fieldParams).length > 0;

  const setSelection = (value) => {
    const service = selectionToConfig(value);
    if (service) onChange({ service, params: {}, ...(hasFields ? { fieldParams } : {}) });
    else onChange(hasFields ? { fieldParams } : null);
  };
  const setParam = (key, value) => {
    onChange({ ...(draftEntry || {}), params: { ...paramValues, [key]: value } });
  };
  // Stored by the field's span layer id, so a rename keeps it.
  const setField = (key, value) => {
    const scope = fieldSchema.find((p) => p.key === key)?.scope;
    const id = value ? fieldIds?.[scope]?.[value] : null;
    const next = { ...fieldParams };
    if (id) next[key] = id;
    else delete next[key];
    const { fieldParams: _gone, ...rest } = draftEntry || {};
    const entry = Object.keys(next).length ? { ...rest, fieldParams: next } : rest;
    onChange(Object.keys(entry).length ? entry : null);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>{spot.label}</CardTitle>
        <CardDescription>{spot.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {spot.builtins.length === 0 && spotServices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No service for this task has connected to this project.
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

        {fieldSchema.length > 0 && (
          <div className="mt-3 border-t pt-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Default fields</p>
            <ServiceParamForm
              schema={fieldSchema}
              values={fieldValues}
              onChange={setField}
              fields={fields}
              disabled={!canManage}
            />
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
              fields={fields}
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
 * lets a selected built-in show options of its own. `saveExtra(batch)` lets
 * the app write a second config key in the same Save: it queues that write on
 * the batch the defaults go in, so the two land together or not at all, and
 * `onExtraSaved` runs once they have landed, for the app to clear its own
 * `extraDirty`. `fieldsOf(project)` gives the project's
 * annotation fields as {scope: [field name]}, for a `field` parameter to be
 * chosen from, and `fieldRolesOf(project)` the role each one's Lexicon field
 * holds ({scope: {field name: role}}), which fills a parameter naming it, and
 * `fieldIdsOf(project)` each one's span layer id ({scope: {field name: id}}),
 * which the task's default fields are stored by.
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
  onExtraSaved,
  fieldsOf,
  fieldRolesOf,
  fieldIdsOf,
  showConfidence = false,
}) => {
  const namespace = configNamespace();
  const [project, setProject] = useState(null);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  // The project's confidence threshold (`plaid.confidence`), shared by every
  // app, saved with the defaults.
  const [threshold, setThreshold] = useState('50');
  const thresholdValue = parseThreshold(threshold);
  // Changed when it differs from what the project stores: typing the stored
  // number back is no change.
  const thresholdDirty =
    showConfidence && thresholdValue !== readConfidenceThreshold(project?.config);

  // Whether anything on the page is unsaved, for a reload that must not
  // throw it away.
  const unsavedRef = useRef(false);
  unsavedRef.current = dirty || extraDirty || thresholdDirty;
  // The draft as it is now, for a Save that lands after a change made while
  // it was out: that change stays unsaved.
  const draftNow = useRef(draft);
  draftNow.current = draft;

  const begin = useLatestCall();
  // `servicesOnly` refreshes which services are online and leaves the saved
  // settings, and an unsaved change to them, as they are.
  const load = useCallback(
    async (servicesOnly = false) => {
      if (!client) return;
      // The project can change under this screen, and a discovery is slow enough
      // that the project just left can answer last.
      const isCurrent = begin();
      setLoading(true);
      try {
        const [p, svcs] = await Promise.all([
          servicesOnly ? null : client.projects.get(projectId),
          client.messages.discoverServices(projectId),
        ]);
        if (!isCurrent()) return;
        setServices(svcs || []);
        if (servicesOnly) return;
        setProject(p);
        setDraft(p?.config?.[namespace]?.serviceDefaults || {});
        setThreshold(thresholdText(p?.config));
        onProjectLoaded?.(p);
        setDirty(false);
      } catch (error) {
        if (!isCurrent()) return;
        notifyError(humanizeError(error), 'Failed to load the services');
      } finally {
        if (isCurrent()) setLoading(false);
      }
    },
    // `onProjectLoaded` is the app's and is redefined every render; naming it
    // here would reload on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, client, begin, namespace],
  );

  useEffect(() => {
    load();
  }, [load]);

  // The online/offline picture goes stale while the tab is hidden; refresh on
  // return. The settings are read again too, unless one is unsaved.
  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) load(unsavedRef.current);
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
    if (!client || (showConfidence && thresholdValue == null)) return;
    setSaving(true);
    try {
      // Written only when changed, expecting what the page read, so a save by
      // someone else since is refused rather than written over. The app's
      // own key goes in the same batch, so a refusal of either writes neither.
      const defaultsChanged = !sameConfig(
        draft,
        storedConfig(project, namespace, 'serviceDefaults') || {},
      );
      await client.batched(async (b) => {
        if (defaultsChanged) {
          b.projects.setConfig(
            projectId,
            namespace,
            'serviceDefaults',
            draft,
            undefined,
            expectStored(project, namespace, 'serviceDefaults'),
          );
        }
        if (thresholdDirty) {
          b.projects.setConfig(
            projectId,
            PLAID_NAMESPACE,
            CONFIDENCE_KEY,
            { threshold: thresholdValue },
            undefined,
            expectStored(project, PLAID_NAMESPACE, CONFIDENCE_KEY),
          );
        }
        if (extraDirty) await saveExtra?.(b, project);
      });
      if (thresholdDirty) {
        setProject((p) => ({
          ...p,
          config: {
            ...p?.config,
            [PLAID_NAMESPACE]: {
              ...p?.config?.[PLAID_NAMESPACE],
              [CONFIDENCE_KEY]: { threshold: thresholdValue },
            },
          },
        }));
      }
      if (defaultsChanged) {
        setProject((p) => ({
          ...p,
          config: {
            ...p?.config,
            [namespace]: { ...p?.config?.[namespace], serviceDefaults: draft },
          },
        }));
      }
      if (extraDirty) onExtraSaved?.();
      setDirty(!sameConfig(draftNow.current, draft));
      notifySuccess('Settings saved');
    } catch (error) {
      notifyError(humanizeError(error), 'Failed to save the defaults');
      // Someone else saved since: show what is stored now.
      if (isConfigConflict(error)) load();
    } finally {
      setSaving(false);
    }
  };

  const discard = async (serviceId) => {
    if (!client) return;
    try {
      await client.messages.discardService(projectId, serviceId);
      await load(unsavedRef.current);
    } catch (error) {
      notifyError(humanizeError(error), 'Failed to forget the service');
    }
  };

  // Seen services that match none of this app's spots would otherwise be
  // invisible (and undeletable); surface them so the registry stays tidy.
  const unmatched = useMemo(
    () => services.filter((s) => !spots.some((spot) => servesTask(s, spot.key))),
    [services, spots],
  );

  if (loading && !project) {
    return <Loading />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-xl text-sm text-muted-foreground">
          Set a default service and its options for each task.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => load(unsavedRef.current)}
          disabled={loading}
        >
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
          fields={project ? (fieldsOf?.(project) ?? null) : null}
          fieldRoles={project ? (fieldRolesOf?.(project) ?? null) : null}
          fieldIds={project ? (fieldIdsOf?.(project) ?? null) : null}
        />
      ))}

      {unmatched.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Other services</CardTitle>
            <CardDescription>Seen on this project, not used by any task here.</CardDescription>
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

      {showConfidence && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Low confidence</CardTitle>
            <CardDescription>
              A machine value below this confidence gets a heavier underline.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Label htmlFor="confidence-threshold">Threshold</Label>
              <Input
                id="confidence-threshold"
                inputMode="numeric"
                dir="ltr"
                className="w-20"
                value={threshold}
                disabled={!canManage}
                aria-invalid={thresholdValue == null}
                onChange={(e) => setThreshold(e.target.value)}
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
            {thresholdValue == null && (
              <p className="text-xs text-destructive-strong">Enter a whole number from 0 to 100.</p>
            )}
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Button
          onClick={save}
          disabled={
            (!dirty && !extraDirty && !thresholdDirty) ||
            (showConfidence && thresholdValue == null) ||
            saving
          }
        >
          {saving ? 'Saving…' : 'Save defaults'}
        </Button>
      )}
    </div>
  );
};
