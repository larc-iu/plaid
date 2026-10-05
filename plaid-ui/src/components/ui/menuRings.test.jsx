// A menu item, a Select option and a picker's active option show where the
// keyboard is with a ring, not only with the accent fill, which is about
// 1.2:1 against the white menu.
import { describe, it, expect } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from './dropdown-menu.jsx';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './select.jsx';

describe('menu focus rings', () => {
  it('rings a focused menu item', async () => {
    const view = await renderComponent(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const item = document.body.querySelector('[role=menuitem]');
    expect(item.className).toContain('focus:ring-1');
    expect(item.className).toContain('focus:ring-inset');
    await view.unmount();
  });

  it('rings a focused Select option', async () => {
    const view = await renderComponent(
      <Select open value="a">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>,
    );
    const option = document.body.querySelector('[role=option]');
    expect(option.className).toContain('focus:ring-1');
    await view.unmount();
  });
});
