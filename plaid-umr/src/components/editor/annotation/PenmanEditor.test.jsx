// Text mode puts one editor on each sentence, so a screen can hold several
// half-typed graphs at once. Leaving loses all of them, and the question says
// how many.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async () => false) }));
vi.mock('@ui/components/shared/ConfirmProvider.jsx', () => ({ useConfirm: () => confirm }));

const { PenmanEditor } = await import('./PenmanEditor.jsx');

const flush = () => act(async () => {});

const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const Screen = ({ graphs }) => (
  <div>
    {Array.from({ length: graphs }, (_, i) => (
      <PenmanEditor
        key={i}
        initial={`(a${i} / thing-0${i})`}
        onApply={() => {}}
        onCancel={() => {}}
      />
    ))}
    {/* The breadcrumb out of the document. */}
    <a
      href="#/projects/p1/documents"
      id="away"
      onClick={(e) => {
        e.preventDefault();
      }}
    >
      Documents
    </a>
  </div>
);

let view = null;

const type = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const typeInEvery = async (text) => {
  for (const box of all(view.container, 'textarea')) {
    await view.step(() => type(box, `${box.value}${text}`));
  }
};

const leave = async () => {
  view.container
    .querySelector('#away')
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();
};

beforeEach(() => {
  confirm.mockReset();
  confirm.mockResolvedValue(false);
  window.history.pushState({ idx: 0, key: 'page' }, '');
});

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
  await flush();
  await tick();
});

describe('a half-typed graph', () => {
  it('is asked about by name when it is the only one', async () => {
    view = await renderComponent(<Screen graphs={1} />);
    await typeInEvery(' ');
    await leave();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'The graph you have typed is not saved. Leaving loses it.',
      }),
    );
  });

  it('is counted with the others when the screen holds three', async () => {
    view = await renderComponent(<Screen graphs={3} />);
    await typeInEvery(' ');
    await leave();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: '3 graphs are not saved. Leaving loses them.',
      }),
    );
  });

  it('counts only the ones that have been typed in', async () => {
    view = await renderComponent(<Screen graphs={3} />);
    const boxes = all(view.container, 'textarea');
    await view.step(() => type(boxes[0], `${boxes[0].value} `));
    await view.step(() => type(boxes[2], `${boxes[2].value} `));
    await leave();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: '2 graphs are not saved. Leaving loses them.',
      }),
    );
  });
});
