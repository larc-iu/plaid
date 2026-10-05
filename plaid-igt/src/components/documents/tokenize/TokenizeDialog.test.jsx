import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { DocumentProvider } from '../contexts/DocumentContext.jsx';
import { TokenizeDialog } from './TokenizeDialog.jsx';

// N2-SERVICES-3: the dialog said "Existing tokens are not overwritten." for
// every method, while a service such as Punkt makes a sentence's words again
// where it splits it differently. The line says what the chosen method does.

vi.mock('@ui/components/services/ServiceRunDialog.jsx', () => ({
  ServiceRunDialog: ({ description }) => <p data-description>{description}</p>,
}));
vi.mock('@ui/components/services/ServiceMethodRow.jsx', () => ({
  ServiceMethodRow: () => null,
}));
vi.mock('@ui/components/services/ServiceRunButton.jsx', () => ({
  ServiceRunButton: () => null,
}));

const render = (service) =>
  renderComponent(
    <DocumentProvider value={{ writeLock: null }}>
      <TokenizeDialog
        ops={{
          spot: { service, params: { errors: {} } },
          tokenizeRun: { running: false },
          handleTokenize: async () => {},
          isTokenizing: false,
          isProcessing: false,
          cancelRequest: async () => {},
        }}
      />
    </DocumentProvider>,
  );

describe('TokenizeDialog', () => {
  it('says the built-in keeps existing words', async () => {
    const view = await render(null);
    expect(view.container.querySelector('[data-description]').textContent).toBe(
      'Existing words are kept.',
    );
    await view.unmount();
  });

  it('says a service may make a sentence’s words again', async () => {
    const view = await render({ serviceId: 'punkt', serviceName: 'Punkt' });
    expect(view.container.querySelector('[data-description]').textContent).toBe(
      "Where the service splits a sentence differently, that sentence's words are made again.",
    );
    await view.unmount();
  });
});
