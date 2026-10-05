import { describe, it, expect } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { DisclosureButton, DisclosureNotice } from './AssistantDisclosure.jsx';

// The operator's statement about an assistant (`--disclosure`), in their words.
describe('the disclosure', () => {
  it('shows the text as given, said to be from the people running the assistant', async () => {
    const view = await renderComponent(
      <DisclosureNotice text={'Runs on our servers.\nNothing leaves them.'} />,
    );
    const box = view.container.querySelector('[data-testid="assistant-disclosure"]');
    expect(box.textContent).toContain('From the people running this assistant');
    expect(box.textContent).toContain('Runs on our servers.\nNothing leaves them.');
    await view.unmount();
  });

  it('draws nothing for an assistant that gave none', async () => {
    const view = await renderComponent(
      <>
        <DisclosureNotice text={null} />
        <DisclosureButton text={null} />
      </>,
    );
    expect(view.container.innerHTML).toBe('');
    await view.unmount();
  });

  it('is behind a labelled icon in the header', async () => {
    const view = await renderComponent(<DisclosureButton text="Runs on our servers." />);
    expect(view.container.querySelector('button[title="About this assistant"]')).not.toBeNull();
    await view.unmount();
  });
});
