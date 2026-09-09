import { useCallback, useMemo, useState } from 'react';
import { filterServicesByTask, getParamSchema } from '@larc-iu/plaid-client';
import {
  decodeSelection,
  encodeServiceSelection,
  encodeBuiltinSelection,
  readSpotDefault,
  resolveInitialSelection,
  selectionFromConfig,
} from '@/domain/serviceDefaults';
import { useServiceParams } from './useServiceParams.js';

const EMPTY = [];

// One integration spot: the methods available for a task, which one is chosen,
// and that method's parameter form. A "method" is an app built-in or a
// registered service, and the two are interchangeable to a caller — which is
// what lets someone bring their own tokenizer or speech detector.
//
// Selection resolves cached choice -> project default -> first built-in ->
// first online service, and a choice is remembered per user in localStorage.
// A service that goes offline between runs falls back rather than leaving a
// dead selection in the box.
//
//   task:      one of TASKS
//   project:   the open project (for config.igt.serviceDefaults)
//   services:  everything discovery returned, online or not
//   builtins:  [{ name, label, schema? }] — always runnable, listed first
//   storageId: localStorage namespace for this spot, e.g. 'tokenize'
export function useServiceSpot({ task, project, services, builtins = EMPTY, storageId }) {
  const selectionKey = `plaid_igt_${storageId}_service`;
  const [choice, setChoice] = useState(null);

  // Only ONLINE services can take work; discovery also returns services that
  // were seen on this project once and have since gone away.
  const online = useMemo(
    () => filterServicesByTask(services, task).filter((s) => s.online !== false),
    [services, task],
  );

  const options = useMemo(
    () => [
      ...builtins.map((b) => ({
        value: encodeBuiltinSelection(b.name),
        label: b.label,
        builtin: b,
        service: null,
      })),
      ...online.map((s) => ({
        value: encodeServiceSelection(s.serviceId),
        label: s.serviceName || s.serviceId,
        builtin: null,
        service: s,
      })),
    ],
    [builtins, online],
  );

  const projectDefault = readSpotDefault(project, task);

  // The user's live choice wins while it names a method that is still there;
  // otherwise fall back to the resolution order.
  const resolved = useMemo(
    () =>
      resolveInitialSelection({
        services: online,
        builtins: builtins.map((b) => b.name),
        cached: choice ?? readStored(selectionKey),
        projectDefault,
      }),
    [online, builtins, choice, selectionKey, projectDefault],
  );
  const selection = options.some((o) => o.value === resolved)
    ? resolved
    : (options[0]?.value ?? null);
  const selected = options.find((o) => o.value === selection) ?? null;

  const choose = useCallback(
    (value) => {
      setChoice(value);
      try {
        if (value) localStorage.setItem(selectionKey, value);
        else localStorage.removeItem(selectionKey);
      } catch {
        /* a blocked store only loses the choice for next time */
      }
    },
    [selectionKey],
  );

  // The chosen method's declared parameters: a service's `extras.parameters`,
  // or a built-in's own schema. Both persist under the spot's namespace.
  const decoded = decodeSelection(selection);
  const schema = useMemo(
    () =>
      selected?.service ? getParamSchema(selected.service) : (selected?.builtin?.schema ?? EMPTY),
    [selected],
  );
  const params = useServiceParams({
    schema,
    storageKey: selection ? `plaid_igt_${storageId}_params_${selection}` : null,
    // A project default's params belong to the method it names, and to no other.
    defaultParams:
      projectDefault && selectionFromConfig(projectDefault) === selection
        ? projectDefault.params
        : null,
  });

  return {
    options,
    selection,
    choose,
    service: selected?.service ?? null,
    builtin: selected?.builtin ?? null,
    isBuiltin: decoded?.kind === 'builtin',
    params,
    // Nothing can run: no built-in, and no service online for this task.
    empty: options.length === 0,
  };
}

const readStored = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
