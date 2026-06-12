import { useState, useEffect, useCallback, useMemo } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import {
  TASKS, filterServicesByTask, servesTask, getParamSchema, buildDefaultValues,
} from '@larc-iu/plaid-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ServiceParamForm } from '../../documents/services/ServiceParamForm';
import { ServiceSummary } from '../../documents/services/ServiceSummary';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { IGT_NAMESPACE } from '@/domain/igtConfig';
import {
  BUILTIN_TOKENIZE_RULE_BASED, BUILTIN_LINK_PRECEDENT,
  encodeServiceSelection, encodeBuiltinSelection, decodeSelection,
  selectionFromConfig, selectionToConfig,
} from '@/domain/serviceDefaults';

// The app's service integration spots: each is a place in the UI where an
// external service can be plugged in, keyed by the task vocabulary services
// declare in their extras. Built-ins are always-available local
// implementations a default may also point at.
const SPOTS = [
  {
    key: TASKS.TOKENIZE,
    label: 'Tokenization',
    description: 'Splits the baseline text into sentences and words (the Tokenize tab).',
    builtins: [{ name: BUILTIN_TOKENIZE_RULE_BASED, label: 'Rule-based Punctuation' }],
  },
  {
    key: TASKS.TRANSCRIBE,
    label: 'Transcription (ASR)',
    description: 'Transcribes and time-aligns audio on the Media tab.',
    builtins: [],
  },
  {
    key: TASKS.LINK_VOCAB,
    label: 'Auto-link vocabulary',
    description: 'Proposes vocabulary links for unlinked words/morphemes (the Auto-link dialog).',
    builtins: [{ name: BUILTIN_LINK_PRECEDENT, label: 'Follow precedent & unique matches' }],
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

const OnlineBadge = ({ online }) => (online
  ? <Badge variant="outline" className="border-green-300 bg-green-50 text-green-700">online</Badge>
  : <Badge variant="outline" className="text-muted-foreground">offline</Badge>);

// One selectable row (a built-in or a service) within a spot card.
function OptionRow({ spotKey, value, label, checked, onSelect, badge, children }) {
  const id = `svc-default-${spotKey}-${value}`;
  return (
    <div className="flex items-center gap-2">
      <input
        type="radio"
        id={id}
        name={`svc-default-${spotKey}`}
        className="h-4 w-4 accent-primary"
        checked={checked}
        onChange={() => onSelect(value)}
      />
      <label htmlFor={id} className="text-sm cursor-pointer">{label}</label>
      {badge}
      {children}
    </div>
  );
}

// One spot's card: every service ever seen for its task (online or not) plus
// any app built-ins, a default selection, and default parameter values for the
// selected default service.
function SpotCard({ spot, services, draftEntry, onChange, onDiscard }) {
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
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{spot.label}</CardTitle>
        <CardDescription>{spot.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {spot.builtins.length === 0 && spotServices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No service for this spot has ever connected to this project. Start one and it will appear here.
          </p>
        ) : (
          <div className="space-y-2">
            <OptionRow
              spotKey={spot.key}
              value="none"
              label="No default (pick per use)"
              checked={selection === 'none'}
              onSelect={setSelection}
            />
            {spot.builtins.map((b) => (
              <OptionRow
                key={b.name}
                spotKey={spot.key}
                value={encodeBuiltinSelection(b.name)}
                label={b.label}
                checked={selection === encodeBuiltinSelection(b.name)}
                onSelect={setSelection}
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
                badge={<OnlineBadge online={svc.online} />}
              >
                {!svc.online && (
                  <span className="text-xs text-muted-foreground">{lastSeenText(svc)}</span>
                )}
                <ServiceSummary service={svc} />
                {!svc.online && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive"
                    title="Forget this service (it reappears if it reconnects)"
                    onClick={() => onDiscard(svc.serviceId)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </OptionRow>
            ))}
          </div>
        )}

        {selectedService && paramSchema.length > 0 && (
          <div className="mt-3 rounded-md border bg-muted/40 p-3">
            <p className="mb-2 text-sm font-medium">
              Default options for {selectedService.serviceName || selectedService.serviceId}
            </p>
            <ServiceParamForm schema={paramSchema} values={paramValues} onChange={setParam} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Project-level Services settings: a registry of every service ever seen on
// this project (online/offline), one card per integration spot, with a
// default service + default parameters per spot. Defaults are stored in
// config.igt.serviceDefaults; editors seed from them (per-user localStorage
// still overrides). The whole settings view is already maintainer-gated.
export const ServicesSettings = ({ projectId, client }) => {
  const [project, setProject] = useState(null);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const [p, svcs] = await Promise.all([
        client.projects.get(projectId),
        client.messages.discoverServices(projectId),
      ]);
      setProject(p);
      setServices(svcs || []);
      setDraft(p?.config?.[IGT_NAMESPACE]?.serviceDefaults || {});
      setDirty(false);
    } catch (error) {
      notifyError(error.message || 'Failed to load services');
    } finally {
      setLoading(false);
    }
  }, [projectId, client]);

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
    if (!client) return;
    setSaving(true);
    try {
      await client.projects.setConfig(projectId, IGT_NAMESPACE, 'serviceDefaults', draft);
      setDirty(false);
      notifySuccess('Service defaults saved');
    } catch (error) {
      notifyError(error.message || 'Failed to save service defaults');
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
      notifyError(error.message || 'Failed to forget service');
    }
  };

  // Seen services that match none of this app's spots would otherwise be
  // invisible (and undeletable); surface them so the registry stays tidy.
  const unmatched = useMemo(
    () => services.filter((s) => !SPOTS.some((spot) => servesTask(s, spot.key))),
    [services],
  );

  if (loading && !project) {
    return (
      <div className="tw flex items-center justify-center py-12 text-muted-foreground">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    );
  }

  return (
    <div className="tw space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-xl text-sm text-muted-foreground">
          Services that have connected to this project are remembered here, online or not.
          Set a default (and default options) for each spot; people can still switch per use.
        </p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {SPOTS.map((spot) => (
        <SpotCard
          key={spot.key}
          spot={spot}
          services={services}
          draftEntry={draft[spot.key] || null}
          onChange={(entry) => setSpotEntry(spot.key, entry)}
          onDiscard={discard}
        />
      ))}

      {unmatched.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Other services</CardTitle>
            <CardDescription>Seen on this project, but not used by any spot in this app.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {unmatched.map((svc) => (
              <div key={svc.serviceId} className="flex items-center gap-2">
                <span className="text-sm">{svc.serviceName || svc.serviceId}</span>
                <OnlineBadge online={svc.online} />
                {!svc.online && <span className="text-xs text-muted-foreground">{lastSeenText(svc)}</span>}
                <ServiceSummary service={svc} />
                {!svc.online && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive"
                    title="Forget this service"
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

      <Button onClick={save} disabled={!dirty || saving}>
        {saving ? 'Saving…' : 'Save defaults'}
      </Button>
    </div>
  );
};
