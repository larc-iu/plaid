// "New Project" method chooser: start from scratch, or create by importing.
// One entry point on the Projects page; new import formats become new cards
// here rather than new buttons there.

import { Link } from 'react-router-dom';
import { PenLine, FileUp, Archive, Table2, AudioLines, ChevronRight } from 'lucide-react';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

const OPTIONS = [
  {
    to: '/projects/new/blank',
    icon: PenLine,
    title: 'Start from scratch',
    description: 'Set up an empty project: orthographies, annotation fields, and vocabularies.',
  },
  {
    to: '/projects/import',
    icon: FileUp,
    title: 'Import from FLEx',
    description:
      'Create a project from a FLEx backup (.fwbackup): texts, glosses, morpheme analyses, translations, and the full lexicon.',
  },
  {
    to: '/projects/import-cldf',
    icon: Table2,
    title: 'Import from CLDF',
    description:
      'Create a project from a Cross-Linguistic Data Formats dataset (.zip): its examples become interlinear texts, its lexicon a vocabulary, and its language the project identity.',
  },
  {
    to: '/projects/import-elan',
    icon: AudioLines,
    title: 'Import from ELAN',
    description:
      'Create a project from a set of ELAN annotation files (.eaf): each file becomes a document, with its tiers, speakers, and time alignment. Every file must share one tier structure.',
  },
  {
    to: '/projects/import-archive',
    icon: Archive,
    title: 'Import a Plaid IGT archive',
    description:
      'Recreate a project from a "Plaid IGT JSON" export (.zip): texts, analyses, vocabularies, time alignment, media, and provenance.',
  },
];

export const NewProjectChooser = () => {
  useDocumentTitle('New Project');
  return (
    <div className="tw mx-auto max-w-3xl px-4 py-8">
      <div className="flex flex-col gap-6">
        <nav className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/projects" className="hover:text-foreground hover:underline">
            Projects
          </Link>
          <span>/</span>
          <span>New Project</span>
        </nav>

        <div>
          <h1 className="text-2xl font-bold">New Project</h1>
          <p className="text-sm text-muted-foreground">How would you like to start?</p>
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
                <span className="block font-medium">{opt.title}</span>
                <span className="block text-sm text-muted-foreground">{opt.description}</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
};
