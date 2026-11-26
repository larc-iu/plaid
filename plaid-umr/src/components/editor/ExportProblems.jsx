import { Notice } from '@ui/components/shared/Notice.jsx';
import { problemPlace } from '../../domain/format/umrFile.js';
import { t } from '@ui/lib/i18n.js';

// The most listed at once: a corpus with a bad value on every sentence would
// otherwise push the page far below the button.
const SHOWN = 50;

/** Why an export was refused: each stored value a .umr file cannot hold. */
export const ExportProblems = ({ problems }) => (
  <Notice tone="error" role="alert">
    <p className="font-medium">{t('Failed to export. These cannot be written to a .umr file:')}</p>
    <ul className="mt-1 list-disc ps-5">
      {problems.slice(0, SHOWN).map((p, i) => (
        <li key={i}>
          <span className="font-medium">{problemPlace(p)}</span>: {p.message}
        </li>
      ))}
    </ul>
    {problems.length > SHOWN && (
      <p className="mt-1">{t('{n} more.', { n: problems.length - SHOWN })}</p>
    )}
  </Notice>
);

/**
 * What the file leaves out: each part of a sentence no root reaches, and each
 * document-level relation naming a node in one (`relation`).
 */
export const LeftOutOfExport = ({ parts }) => {
  const nodes = parts.reduce((sum, p) => sum + p.nodes, 0);
  const relations = parts.filter((p) => p.relation).length;
  const heading =
    nodes && relations
      ? t(
          '{nodes, plural, one {# node} other {# nodes}} and {relations, plural, one {# document-level relation} other {# document-level relations}} left out of the file:',
          { nodes, relations },
        )
      : nodes
        ? t('{n, plural, one {# node} other {# nodes}} left out of the file:', { n: nodes })
        : t(
            '{n, plural, one {# document-level relation} other {# document-level relations}} left out of the file:',
            { n: relations },
          );
  return (
    <Notice tone="warning">
      <p className="font-medium">{heading}</p>
      <ul className="mt-1 list-disc ps-5">
        {parts.slice(0, SHOWN).map((p, i) => (
          <li key={i}>
            <span className="font-medium">{t('Sentence {n}', { n: p.sentence })}</span>: {p.message}
          </li>
        ))}
      </ul>
      {parts.length > SHOWN && (
        <p className="mt-1">{t('{n} more.', { n: parts.length - SHOWN })}</p>
      )}
    </Notice>
  );
};
