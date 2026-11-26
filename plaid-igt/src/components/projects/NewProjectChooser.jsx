// "New Project" method chooser: start from scratch, or create by importing.
// One entry point on the Projects page; new import formats become new cards
// here rather than new buttons there.

import { Link } from 'react-router-dom';
import { PenLine, FileUp, FileText, Archive, Table2, AudioLines, ChevronRight } from 'lucide-react';
import { Breadcrumb } from '@ui/components/shared/Breadcrumb.jsx';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { FORM_PAGE_WIDTH } from '@ui/lib/pageWidth.js';
import { TYPE } from '@ui/lib/typeScale.js';
import { t, msg } from '@ui/lib/i18n.js';

const OPTIONS = [
  {
    to: '/projects/new/blank',
    icon: PenLine,
    title: msg('Start from scratch'),
    description: msg(
      'Set up an empty project: orthographies, annotation fields, and vocabularies.',
    ),
  },
  {
    to: '/projects/import',
    icon: FileUp,
    title: msg('Import from FLEx (.fwbackup)'),
    description: msg(
      'Create a project from a FLEx backup (.fwbackup): texts, glosses, morpheme analyses, translations, and the full lexicon.',
    ),
  },
  {
    to: '/projects/import-flextext',
    icon: FileText,
    title: msg('Import from FLEx (.flextext)'),
    description: msg(
      'Create a project from FLEx interlinear texts (.flextext files): texts, glosses, morpheme analyses, and translations, without the lexicon.',
    ),
  },
  {
    to: '/projects/import-cldf',
    icon: Table2,
    title: msg('Import from CLDF'),
    description: msg(
      'Create a project from a Cross-Linguistic Data Formats dataset (.zip): its examples become interlinear texts, its lexicon a vocabulary, and its language the project identity.',
    ),
  },
  {
    to: '/projects/import-elan',
    icon: AudioLines,
    title: msg('Import from ELAN or Praat'),
    description: msg(
      'Create a project from a set of ELAN annotation files (.eaf) or Praat TextGrids: each file becomes a document, with its tiers, speakers, and time alignment. A tier must mean the same thing in every file.',
    ),
  },
  {
    to: '/projects/import-archive',
    icon: Archive,
    title: msg('Import a Plaid IGT archive'),
    description: msg(
      'Recreate a project from a "Plaid IGT JSON" export (.zip): texts, analyses, vocabularies, time alignment, media, and provenance.',
    ),
  },
];

export const NewProjectChooser = () => {
  useDocumentTitle(t('New project'));
  return (
    <div className={FORM_PAGE_WIDTH}>
      <div className="flex flex-col gap-6">
        <Breadcrumb items={[{ label: t('Projects'), to: '/projects', fixed: true }]} />

        <div>
          <h1 className={TYPE.page}>{t('New project')}</h1>
        </div>

        <div className="flex flex-col gap-3">
          {OPTIONS.map((opt) => (
            <Link
              key={opt.to}
              to={opt.to}
              className="flex items-center gap-4 rounded-lg border bg-card p-5 text-left hover:bg-muted/50"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-background">
                <opt.icon className="h-5 w-5 text-muted-foreground" />
              </span>
              <span className="flex-1">
                <span className="block font-medium">{t(opt.title)}</span>
                <span className="block text-sm text-muted-foreground">{t(opt.description)}</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
};
