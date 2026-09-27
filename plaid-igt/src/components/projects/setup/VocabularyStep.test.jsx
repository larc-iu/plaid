import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, byText } from '@ui/test/renderComponent.jsx';

// The setup wizard links the vocabularies ticked here once the project is
// made, and core refuses a link from anyone who does not maintain the
// vocabulary. So the wizard marks those rows the way Project settings does,
// rather than offering a tick that fails at the end of setup.

vi.mock('@/utils/feedback', () => ({ notifyError: vi.fn() }));

let auth;
vi.mock('@/contexts/AuthContext.jsx', () => ({ useAuth: () => auth }));

import { VocabularyStep } from './VocabularyStep.jsx';

const client = {
  vocabLayers: {
    list: vi.fn(async () => [
      { id: 'v1', name: 'Mine', maintainers: ['me@x.org'] },
      { id: 'v2', name: 'Theirs', maintainers: ['other@x.org'] },
    ]),
  },
};

const rowOf = (root, name) => byText(root, 'tbody tr', name);
const boxOf = (root, name) => rowOf(root, name).querySelector('input[type=checkbox]');

const mount = (onDataChange = () => {}) =>
  renderComponent(
    <MemoryRouter>
      <VocabularyStep data={{}} onDataChange={onDataChange} client={client} />
    </MemoryRouter>,
  );

beforeEach(() => {
  auth = { user: { id: 'me@x.org', isAdmin: false } };
});

describe('the setup wizard, Vocabularies', () => {
  it('will not tick a vocabulary the user does not maintain', async () => {
    const onDataChange = vi.fn();
    const view = await mount(onDataChange);
    expect(boxOf(view.container, 'Mine').disabled).toBe(false);
    expect(boxOf(view.container, 'Theirs').disabled).toBe(true);
    expect(rowOf(view.container, 'Theirs').textContent).toContain(
      'Only its maintainers can link it.',
    );
    await view.step(() => rowOf(view.container, 'Theirs').click());
    expect(onDataChange).not.toHaveBeenCalled();
    await view.step(() => rowOf(view.container, 'Mine').click());
    expect(onDataChange).toHaveBeenCalledTimes(1);
    const sent = onDataChange.mock.calls[0][0].vocabularies;
    expect(sent.filter((v) => v.enabled).map((v) => v.id)).toEqual(['v1']);
    await view.unmount();
  });

  it('lets an admin tick any vocabulary', async () => {
    auth = { user: { id: 'admin@x.org', isAdmin: true } };
    const view = await mount();
    expect(boxOf(view.container, 'Theirs').disabled).toBe(false);
    await view.unmount();
  });
});
