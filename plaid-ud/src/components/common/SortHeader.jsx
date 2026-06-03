import { UnstyledButton, Group, Text } from '@mantine/core';
import { IconChevronUp, IconChevronDown, IconSelector } from '@tabler/icons-react';

// A clickable column header for the list views. Shows a direction chevron when
// it's the active sort key, and a neutral selector glyph otherwise. Sort state
// is { key, dir }; toggle/compare helpers live in utils/sorting.js.
export function SortButton({ field, sort, onSort, children, width, align = 'right' }) {
  const active = sort.key === field;
  const Icon = active ? (sort.dir === 'asc' ? IconChevronUp : IconChevronDown) : IconSelector;
  return (
    <UnstyledButton
      onClick={() => onSort(field)}
      style={{ width, flex: width ? undefined : 1 }}
    >
      <Group gap={4} justify={align === 'right' ? 'flex-end' : 'flex-start'} wrap="nowrap">
        <Text size="xs" fw={700} c={active ? 'dark' : 'dimmed'} tt="uppercase">{children}</Text>
        <Icon size={13} color={`var(--mantine-color-${active ? 'dark' : 'gray'}-5)`} />
      </Group>
    </UnstyledButton>
  );
}
