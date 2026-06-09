import { Popover, ActionIcon, Text, ScrollArea } from '@mantine/core';
import IconInfoCircle from '@tabler/icons-react/dist/esm/icons/IconInfoCircle.mjs';
import Markdown from 'react-markdown';
import { getServiceSummary } from '@larc-iu/plaid-client';

// Compact, lightly-styled markdown renderers. Inline styles keep them
// independent of the design system. react-markdown does not render raw HTML and
// sanitizes link protocols, so a service-supplied summary can't inject markup.
const mdComponents = {
  h1: ({ node: _node, ...p }) => <div style={{ fontWeight: 600, fontSize: '0.95rem', margin: '0.5em 0 0.2em' }} {...p} />,
  h2: ({ node: _node, ...p }) => <div style={{ fontWeight: 600, fontSize: '0.9rem', margin: '0.5em 0 0.2em' }} {...p} />,
  h3: ({ node: _node, ...p }) => <div style={{ fontWeight: 600, fontSize: '0.85rem', margin: '0.5em 0 0.2em' }} {...p} />,
  p: ({ node: _node, ...p }) => <p style={{ margin: '0.4em 0' }} {...p} />,
  ul: ({ node: _node, ...p }) => <ul style={{ margin: '0.3em 0', paddingLeft: '1.2em', listStyle: 'disc' }} {...p} />,
  ol: ({ node: _node, ...p }) => <ol style={{ margin: '0.3em 0', paddingLeft: '1.2em' }} {...p} />,
  li: ({ node: _node, ...p }) => <li style={{ margin: '0.15em 0' }} {...p} />,
  a: ({ node: _node, ...p }) => <a target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb', textDecoration: 'underline' }} {...p} />,
  code: ({ node: _node, ...p }) => <code style={{ background: 'rgba(0,0,0,0.06)', padding: '0 0.25em', borderRadius: 3 }} {...p} />,
  blockquote: ({ node: _node, ...p }) => <blockquote style={{ margin: '0.4em 0', paddingLeft: '0.8em', borderLeft: '3px solid rgba(0,0,0,0.15)', opacity: 0.85 }} {...p} />,
};

// Info popover showing a service's self-provided summary (markdown via
// extras.summary, else the short description).
export function ServiceSummary({ service }) {
  const summary = getServiceSummary(service);
  if (!service || !summary) return null;
  return (
    <Popover width={380} position="bottom-start" withArrow shadow="md">
      <Popover.Target>
        <ActionIcon variant="subtle" color="gray" aria-label={`About ${service.serviceName || 'service'}`}>
          <IconInfoCircle size={18} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        {service.serviceName && <Text fw={600} size="sm" mb={4}>{service.serviceName}</Text>}
        <ScrollArea.Autosize mah={300}>
          {/* component="div" so block-level markdown isn't nested inside a <p>. */}
          <Text size="sm" c="dimmed" component="div">
            <Markdown components={mdComponents}>{summary}</Markdown>
          </Text>
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
}
