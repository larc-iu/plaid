// "New Project" method chooser: start from scratch, or create by importing.
// One entry point on the Projects page; new import formats become new cards
// here rather than new buttons there.

import { Link, useNavigate } from 'react-router-dom';
import { PenLine, FileUp, ChevronRight } from 'lucide-react';

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
    title: 'Import from FieldWorks',
    description: 'Create a project from a FLEx backup (.fwbackup) — texts, glosses, morpheme analyses, translations, and the full lexicon.',
  },
];

export const NewProjectChooser = () => {
  const navigate = useNavigate();
  return (
    <div className="tw mx-auto max-w-3xl px-4 py-8">
      <div className="flex flex-col gap-6">
        <nav className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/projects" className="hover:text-foreground hover:underline">Projects</Link>
          <span>/</span>
          <span>New Project</span>
        </nav>

        <div>
          <h1 className="text-2xl font-bold">New Project</h1>
          <p className="text-sm text-muted-foreground">How would you like to start?</p>
        </div>

        <div className="flex flex-col gap-3">
          {OPTIONS.map((opt) => (
            <button
              key={opt.to}
              type="button"
              onClick={() => navigate(opt.to)}
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
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
