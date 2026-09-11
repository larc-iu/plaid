import { describe, it, expect, beforeEach } from 'vitest';
import { TASKS } from '@larc-iu/plaid-client';
import { renderComponent } from '../test/renderComponent.jsx';
import { useServiceSpot } from './useServiceSpot.js';

// The spot hook is what makes a built-in and a registered service the same
// thing to a caller, so these are the rules that guarantee it: what gets
// listed, which one wins, and where the options come from.

const BUILTIN = { name: 'rule-based', label: 'Rule-based' };
const BUILTIN_WITH_OPTS = {
  name: 'silero',
  label: 'Silero',
  schema: [{ key: 'threshold', label: 'Threshold', type: 'number', min: 0, max: 1, default: 0.5 }],
};

const service = (id, over = {}) => ({
  serviceId: id,
  serviceName: id.toUpperCase(),
  extras: { tasks: [TASKS.TOKENIZE], parameters: [] },
  ...over,
});

// Render the hook and expose its latest value.
async function mount(props) {
  const seen = { current: null };
  const Probe = (p) => {
    seen.current = useServiceSpot(p);
    return null;
  };
  const r = await renderComponent(<Probe {...props} />);
  return { ...r, spot: () => seen.current, probe: Probe };
}

const base = {
  task: TASKS.TOKENIZE,
  project: null,
  services: [],
  builtins: [BUILTIN],
  storageId: 'test_spot',
};

describe('useServiceSpot', () => {
  beforeEach(() => localStorage.clear());

  it('lists built-ins first, then only the services that are online for the task', async () => {
    const { spot } = await mount({
      ...base,
      services: [
        service('a'),
        service('b', { online: false }),
        service('c', { extras: { tasks: [TASKS.TRANSCRIBE] } }),
      ],
    });
    expect(spot().options.map((o) => o.value)).toEqual(['builtin:rule-based', 'service:a']);
  });

  it('falls back to the first method when nothing is chosen', async () => {
    const { spot } = await mount({ ...base, services: [service('a')] });
    expect(spot().selection).toBe('builtin:rule-based');
    expect(spot().isBuiltin).toBe(true);
    expect(spot().service).toBe(null);
  });

  it('remembers a choice, and hands back the chosen service', async () => {
    const { spot, step } = await mount({ ...base, services: [service('a')] });
    await step(() => spot().choose('service:a'));
    expect(spot().selection).toBe('service:a');
    expect(spot().service.serviceId).toBe('a');
    expect(localStorage.getItem('plaid_igt_test_spot_service')).toBe('service:a');
  });

  it('drops a remembered service that is no longer online', async () => {
    localStorage.setItem('plaid_igt_test_spot_service', 'service:a');
    const { spot } = await mount({ ...base, services: [service('a', { online: false })] });
    expect(spot().selection).toBe('builtin:rule-based');
  });

  it("takes the project default over the app's own first choice", async () => {
    const { spot } = await mount({
      ...base,
      services: [service('a')],
      project: {
        config: { igt: { serviceDefaults: { [TASKS.TOKENIZE]: { service: { serviceId: 'a' } } } } },
      },
    });
    expect(spot().selection).toBe('service:a');
  });

  it('keeps the user choice above the project default', async () => {
    localStorage.setItem('plaid_igt_test_spot_service', 'builtin:rule-based');
    const { spot } = await mount({
      ...base,
      services: [service('a')],
      project: {
        config: { igt: { serviceDefaults: { [TASKS.TOKENIZE]: { service: { serviceId: 'a' } } } } },
      },
    });
    expect(spot().selection).toBe('builtin:rule-based');
  });

  it("renders a built-in's own options through the same parameter form", async () => {
    const { spot } = await mount({
      ...base,
      task: TASKS.DETECT_SPEECH,
      builtins: [BUILTIN_WITH_OPTS],
    });
    expect(spot().params.schema).toHaveLength(1);
    expect(spot().params.values).toEqual({ threshold: 0.5 });
  });

  it('persists a built-in option under the spot, and resets it', async () => {
    const { spot, step } = await mount({
      ...base,
      task: TASKS.DETECT_SPEECH,
      builtins: [BUILTIN_WITH_OPTS],
    });
    await step(() => spot().params.setParam('threshold', 0.8));
    expect(spot().params.values.threshold).toBe(0.8);
    expect(spot().params.isDirty).toBe(true);
    expect(localStorage.getItem('plaid_igt_test_spot_params_builtin:silero')).toContain('0.8');

    await step(() => spot().params.reset());
    expect(spot().params.values.threshold).toBe(0.5);
    expect(spot().params.isDirty).toBe(false);
    expect(localStorage.getItem('plaid_igt_test_spot_params_builtin:silero')).toBe(null);
  });

  it('applies the project default params only to the method they name', async () => {
    const project = {
      config: {
        igt: {
          serviceDefaults: {
            [TASKS.TOKENIZE]: { service: { serviceId: 'a' }, params: { lang: 'de' } },
          },
        },
      },
    };
    const withParams = service('a', {
      extras: {
        tasks: [TASKS.TOKENIZE],
        parameters: [{ key: 'lang', label: 'Language', type: 'string', default: 'en' }],
      },
    });
    const { spot, step } = await mount({ ...base, services: [withParams], project });
    expect(spot().selection).toBe('service:a');
    expect(spot().params.values).toEqual({ lang: 'de' });

    // The built-in declares no parameters, so the default cannot leak onto it.
    await step(() => spot().choose('builtin:rule-based'));
    expect(spot().params.values).toEqual({});
  });

  it('reports empty when there is no built-in and nothing online', async () => {
    const { spot } = await mount({ ...base, builtins: [], services: [] });
    expect(spot().empty).toBe(true);
    expect(spot().selection).toBe(null);
  });
});
