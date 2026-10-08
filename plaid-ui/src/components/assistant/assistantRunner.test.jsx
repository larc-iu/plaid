import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { AssistantPicker } from './ConversationList.jsx';
import { assistantsAmong, runByLine } from './useAssistantAvailable.js';
import { useAssistantChoice } from './useAssistantChoice.js';
import { serviceCache } from './jobs.js';

// Who runs each assistant (Luke, 2026-10-08). A service acts for members other
// than its runner only where the runner maintains the project or is an admin,
// and discovery says so as `servesYou`. The picker names each one's runner, and
// never offers one that would refuse the reader.

const svc = (id, over = {}) => ({
  serviceId: id,
  serviceName: `Assistant ${id}`,
  online: true,
  extras: { model: `model/${id}`, app: 'igt', tasks: ['assist'] },
  ...over,
});

beforeEach(() => {
  serviceCache.clear();
});

describe('runByLine', () => {
  it('names the runner, or says it is you', () => {
    expect(runByLine({ runnerName: 'Ana', runByYou: false })).toBe('run by Ana');
    expect(runByLine({ runnerName: 'Ana', runByYou: true })).toBe('run by you');
    expect(runByLine({})).toBe('');
  });
});

describe('assistantsAmong', () => {
  it('leaves out an assistant that would not take the reader’s requests', () => {
    const found = [
      svc('igt:writer', { runnerName: 'Bo', servesYou: false }),
      svc('igt:maintainer', { runnerName: 'Ana', servesYou: true }),
      svc('igt:mine', { runnerName: 'Cy', runByYou: true, servesYou: true }),
    ];
    expect(assistantsAmong(found, 'igt').map((s) => s.serviceId)).toEqual([
      'igt:maintainer',
      'igt:mine',
    ]);
  });
});

describe('useAssistantChoice', () => {
  it('never picks by default an assistant that would refuse the reader', async () => {
    const client = {
      messages: {
        discoverServices: vi
          .fn()
          .mockResolvedValue([
            svc('igt:a-writer', { runnerName: 'Bo', servesYou: false }),
            svc('igt:b-maintainer', { runnerName: 'Ana', servesYou: true }),
          ]),
      },
    };
    const box = {};
    const Probe = () => {
      box.choice = useAssistantChoice({ client, projectId: 'p1', app: 'igt', meta: null });
      return <span data-testid="c">{box.choice.service?.serviceId ?? 'none'}</span>;
    };
    const r = await renderComponent(<Probe />);
    await r.step(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(r.container.querySelector('[data-testid="c"]').textContent).toBe('igt:b-maintainer');
    expect(box.choice.canChoose).toBe(false);
    await r.unmount();
  });
});

describe('AssistantPicker', () => {
  it('shows who runs each assistant under its name, and the name alone once chosen', async () => {
    const assistants = [
      svc('igt:one', { runnerName: 'Ana', runByYou: false }),
      svc('igt:two', { runnerName: 'Cy', runByYou: true }),
    ];
    const r = await renderComponent(
      <AssistantPicker assistants={assistants} value="igt:one" onChange={() => {}} />,
    );
    const trigger = r.container.querySelector('button[aria-label="Assistant"]');
    expect(trigger.textContent).toBe('Assistant igt:one');
    await r.step(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((res) => setTimeout(res, 0));
    });
    const options = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(options).toEqual(['Assistant igt:onerun by Ana', 'Assistant igt:tworun by you']);
    await r.unmount();
  });
});
