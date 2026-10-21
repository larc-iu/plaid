import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { FlextextOptions } from './FlextextOptions.jsx';

// A preset's metadata mapping is stored. Opening a preset that has none
// proposes nothing (existing presets got theirs from a backfill), so an
// untouched preset is never changed by being looked at.
describe('FlextextOptions', () => {
  it('opens a preset without a metadata mapping and changes nothing', async () => {
    const onChange = vi.fn();
    const layers = {
      orthographies: [],
      sentFields: [],
      wordFields: [],
      morphFields: [],
      fieldLangs: {},
      documentMetadata: ['Title', 'Source'],
    };
    const view = await renderComponent(
      <FlextextOptions options={{ langs: {}, fieldMap: {} }} layers={layers} onChange={onChange} />,
    );
    await view.step(async () => {});
    expect(onChange).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Document metadata');
    await view.unmount();
  });
});
