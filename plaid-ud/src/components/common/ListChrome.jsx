import { ActionIcon, CloseButton, Group, Text, TextInput } from '@mantine/core';
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconSearch,
} from '@tabler/icons-react';

// The chrome every browsable list in the app wears: one search box, one count,
// one pager. Kept together so that a list of documents, of search hits and of
// users are told apart by their rows and by nothing else. Matches the
// convention plaid-igt landed, in copy and layout — the markup cannot be
// shared, since that app is Tailwind and this one is Mantine.

// A search box with its magnifier and a clear button. `onChange` takes the
// string, not the event, because no call site wanted the event.
export const SearchInput = ({ value, onChange, placeholder = 'Search…', w = 240, ...props }) => (
  <TextInput
    // A search box is not prose, and half of what is typed into these is a
    // form in the language being annotated.
    spellCheck={false}
    placeholder={placeholder}
    aria-label={placeholder.replace(/…$/, '')}
    value={value}
    onChange={(e) => onChange(e.currentTarget.value)}
    leftSection={<IconSearch size={16} />}
    rightSection={
      value ? (
        <CloseButton size="sm" onClick={() => onChange('')} aria-label="Clear search" />
      ) : null
    }
    w={w}
    {...props}
  />
);

const plural = (n, noun) => (n === 1 ? noun : `${noun}s`);

// How much of the list a search is hiding. Sits beside the search box.
export const ListCount = ({ shown, total, noun = 'item' }) => (
  <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
    {shown === total
      ? `${total.toLocaleString()} ${plural(total, noun)}`
      : `${shown.toLocaleString()} of ${total.toLocaleString()} ${plural(total, noun)}`}
  </Text>
);

// A note under a list: what a capped search left out, and how to see it.
export const ListHint = ({ children }) => (
  <Text size="xs" c="dimmed">
    {children}
  </Text>
);

const PagerButton = ({ icon, label, ...props }) => {
  // Uppercase local rather than a renamed parameter: this config drops
  // eslint-plugin-react, so no-unused-vars only spares names matching
  // varsIgnorePattern, which applies to variables and not to arguments.
  const Icon = icon;
  return (
    <ActionIcon variant="subtle" color="gray" size="sm" aria-label={label} title={label} {...props}>
      <Icon size={15} />
    </ActionIcon>
  );
};

const strip = (position) => ({
  padding: '0.35rem 0.5rem',
  [position === 'top' ? 'borderBottom' : 'borderTop']: '1px solid var(--mantine-color-gray-2)',
});

// The pager strip, which belongs inside the list's own border. A paged list
// carries one above the rows and one below, so that turning the page never
// means scrolling to the end to find the control. Takes the shape
// `pageSlice`/`usePagedList` return, so a call site spreads it:
//   <ListPager {...paged} onPage={paged.setPage} position="top" />
// Renders nothing when everything already fits on one page.
export const ListPager = ({
  page,
  pageCount,
  rangeStart,
  rangeEnd,
  total,
  onPage,
  position = 'bottom',
}) => {
  if (pageCount <= 1) return null;
  const atStart = page === 0;
  const atEnd = page >= pageCount - 1;
  return (
    <Group justify="space-between" gap={4} wrap="nowrap" style={strip(position)}>
      <Group gap={0} wrap="nowrap">
        <PagerButton
          icon={IconChevronsLeft}
          label="First page"
          disabled={atStart}
          onClick={() => onPage(0)}
        />
        <PagerButton
          icon={IconChevronLeft}
          label="Previous page"
          disabled={atStart}
          onClick={() => onPage(page - 1)}
        />
      </Group>
      <Text size="xs" c="dimmed" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of {total.toLocaleString()}
      </Text>
      <Group gap={0} wrap="nowrap">
        <PagerButton
          icon={IconChevronRight}
          label="Next page"
          disabled={atEnd}
          onClick={() => onPage(page + 1)}
        />
        <PagerButton
          icon={IconChevronsRight}
          label="Last page"
          disabled={atEnd}
          onClick={() => onPage(pageCount - 1)}
        />
      </Group>
    </Group>
  );
};

// The same strip for a list paged by a keyset cursor, which has no total and
// so no last page to jump to. Used by the admin user directory. Renders
// nothing when there is only ever one page.
//
// `busy` disables the buttons without hiding the strip: a fetch must not make
// the control disappear and come back under the reader's cursor.
export const CursorPager = ({
  page,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  busy = false,
  position = 'bottom',
}) => {
  if (!hasPrevious && !hasNext) return null;
  return (
    <Group justify="space-between" gap={4} wrap="nowrap" style={strip(position)}>
      <PagerButton
        icon={IconChevronLeft}
        label="Previous page"
        disabled={!hasPrevious || busy}
        onClick={onPrevious}
      />
      <Text size="xs" c="dimmed" style={{ fontVariantNumeric: 'tabular-nums' }}>
        Page {page.toLocaleString()}
      </Text>
      <PagerButton
        icon={IconChevronRight}
        label="Next page"
        disabled={!hasNext || busy}
        onClick={onNext}
      />
    </Group>
  );
};
