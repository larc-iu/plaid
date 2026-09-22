// "Import from FLEx": create a project from a FieldWorks backup (.fwbackup),
// or from FLEx interlinear texts (.flextext files), which have no lexicon.
// One page for both, since past reading the file they are one import: the
// .flextext reader produces the IR the backup parser does, and the same
// engine writes it.
//
// Flow: pick file(s) → parse client-side (streaming, drops non-IGT objects) →
// review (project name, orthography names, derived fields, alignment
// warnings) → run (shared project setup, then the import engine) → done.
//
// Resume: the created project id and setup completion are kept in refs for
// the lifetime of this page, so Retry after a mid-import failure re-runs
// against the same project; the engine skips documents already marked done
// and redoes half-imported ones.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Upload, FileUp, Check, X, RefreshCw, Square } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Badge } from '@ui/components/ui/badge';
import { useAuth } from '../../contexts/AuthContext';
import { notifyError, humanizeError } from '@/utils/feedback';
import { readFwbackup } from '../../import/flex/fwbackup';
import { parseFwdata } from '../../import/flex/fwdataParser';
import { parseFlextextFiles } from '../../import/flex/flextextParser';
import { buildDocuments } from '../../import/flex/buildDocuments';
import { deriveImportConfig, runImport } from '../../import/flex/importEngine';
import { readImportState } from '../../domain/igtConfig';
import { useResumeImport } from '@/hooks/useResumeImport';
import { useProjectImportRun } from '@/hooks/useProjectImportRun';
import { setupDataFor } from '../../import/project';

import { documentFraction, documentLabel } from '../../import/progress';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { humanizeFieldName } from '@/domain/vocabFields';
import { scopeBadgeClass } from '@/domain/scopeColors';
import { canManageVocabulary } from '@ui/domain/permissions.js';

// What differs between the two FieldWorks formats, on screen and in the
// import record (`kind`, which also names the route a resume comes back to).
const FORMATS = {
  fwbackup: {
    kind: 'FLEx',
    title: 'Import from FLEx (.fwbackup)',
    pageTitle: 'Import FLEx Project',
    accept: '.fwbackup,application/zip',
    drop: 'Drop a .fwbackup file here, or click to choose',
    where: 'In FieldWorks: File → Project Management → Back up this Project',
    reading: 'Reading backup… large projects can take a few seconds.',
    again: 'Choose the same backup: what is already there is kept.',
    operation: 'Import FLEx project',
  },
  flextext: {
    kind: 'FLEx .flextext',
    title: 'Import from FLEx (.flextext)',
    pageTitle: 'Import FLEx Texts',
    accept: '.flextext',
    drop: 'Drop .flextext files here, or click to choose',
    where: 'In FieldWorks: File → Export Interlinear → FLExText',
    reading: 'Reading files…',
    again: 'Choose the same files: what is already there is kept.',
    operation: 'Import FLEx texts',
  },
};

export const ImportFlexProject = ({ format = 'fwbackup' }) => {
  const fmt = FORMATS[format];
  const flextext = format === 'flextext';
  useDocumentTitle(fmt.pageTitle);
  const { client, user } = useAuth();
  const fileInputRef = useRef(null);
  // {sourceName, fileCount, ir, build, analysisWssAvailable}
  const [parsed, setParsed] = useState(null);
  const [projectName, setProjectName] = useState('');
  const [orthoNames, setOrthoNames] = useState({}); // ws → display name
  const [selectedTexts, setSelectedTexts] = useState(new Set()); // doc guids
  const [selectedWss, setSelectedWss] = useState(new Set()); // analysis ws tags
  // A FLEx category is one thing named in each analysis writing system, so
  // one of those names is imported rather than all of them.
  const [posWs, setPosWs] = useState(null);
  const [selectedLexFields, setSelectedLexFields] = useState(new Set()); // FLEx field names
  // Where the lexicon goes: a new vocab (named here; null = the default name
  // until edited) or one of the existing vocabs this user maintains.
  const [lexiconMode, setLexiconMode] = useState('new'); // new | existing
  // Variants and complex forms are references between entries. Off unless
  // asked for: they are FLEx's own structure, not everyone's.
  const [importVariants, setImportVariants] = useState(false);
  const [lexiconName, setLexiconName] = useState(null);
  const [existingVocabs, setExistingVocabs] = useState([]);
  const [existingVocabId, setExistingVocabId] = useState('');

  // Survive retries within this page session (see header comment).
  const { resumeId, resumeName, resumeProject, finishAsIs } = useResumeImport(client);
  const { stage, setStage, progress, runError, results, projectIdRef, setupDoneRef, stop, start } =
    useProjectImportRun({ client, kind: fmt.kind, resumeId });
  // On a resume the lexicon is the one the record names: the run writes into
  // it whatever the screen would otherwise offer.
  const resumeRecord = resumeProject ? readImportState(resumeProject.config) : null;
  const resumedLexicon =
    (resumeProject?.vocabs || []).find((v) => v.id === resumeRecord?.vocabId) ?? null;

  // A backup is one file, and names its project. A .flextext is one of any
  // number, named for the texts it holds.
  const readFiles = async (files) => {
    if (!flextext) {
      const bytes = new Uint8Array(await files[0].arrayBuffer());
      // Let the spinner paint before the synchronous parse occupies the thread.
      await new Promise((r) => setTimeout(r, 50));
      const { name, xml } = readFwbackup(bytes);
      return { sourceName: name, fileCount: 1, projectName: name, ir: parseFwdata(xml) };
    }
    const picked = files.filter((f) => /\.flextext$/i.test(f.name));
    if (!picked.length) throw new Error('No .flextext files among those chosen');
    const texts = await Promise.all(
      picked.map(async (f) => ({ name: f.name, xml: await f.text() })),
    );
    await new Promise((r) => setTimeout(r, 50));
    const ir = parseFlextextFiles(texts);
    for (const f of files) {
      if (!picked.includes(f)) ir.warnings.unshift(`${f.name} is not a .flextext file. Not read.`);
    }
    const one = picked.length === 1;
    return {
      sourceName: one ? picked[0].name : `${picked[0].name} and ${picked.length - 1} more`,
      fileCount: picked.length,
      projectName: one ? picked[0].name.replace(/\.flextext$/i, '') : '',
      ir,
    };
  };

  const handleFiles = async (fileList) => {
    const files = [...(fileList ?? [])];
    if (!files.length) return;
    setStage('parsing');
    try {
      const { sourceName, fileCount, projectName: name, ir } = await readFiles(files);
      const build = buildDocuments(ir);
      if (build.documents.length === 0) {
        throw new Error(
          flextext ? 'No texts found in these files' : 'No interlinear texts found in this backup',
        );
      }
      // Analysis writing systems that actually carry data, project order first
      const used = new Set([
        ...ir.wsUsage.wordGloss,
        ...ir.wsUsage.morphGloss,
        ...ir.wsUsage.freeTranslation,
        ...ir.wsUsage.literalTranslation,
        ...ir.wsUsage.note,
        ...ir.wsUsage.lexGloss,
        ...ir.wsUsage.lexDefinition,
      ]);
      const analysisWssAvailable = [
        ...ir.writingSystems.analysis.filter((ws) => used.has(ws)),
        ...[...used].filter((ws) => !ir.writingSystems.analysis.includes(ws)),
      ];
      setParsed({ sourceName, fileCount, ir, build, analysisWssAvailable });
      setProjectName(name);
      setOrthoNames(Object.fromEntries(build.orthographyWss.map((ws) => [ws, ws])));
      setSelectedTexts(new Set(build.documents.map((d) => d.guid)));
      setSelectedWss(new Set(analysisWssAvailable));
      setPosWs(ir.posWs ?? null);
      // Every other lexicon field the file has values for starts ticked. The
      // parser only reports fields with non-empty text, so this is "keep what
      // is there": an unticked default cost the CLDF importer its POS tier
      // and here would silently drop the notes fields of a whole dictionary.
      setSelectedLexFields(new Set(ir.lexiconFields.map((f) => f.name)));
      setLexiconMode('new');
      setLexiconName(null);
      setExistingVocabId('');
      setStage('review');
      // Adding entries needs vocab-maintainer rights, so only offer those.
      if (!flextext) {
        client.vocabLayers
          .list()
          .then((all) => setExistingVocabs((all || []).filter((v) => canManageVocabulary(v, user))))
          .catch((err) => console.warn('Could not list vocabularies:', err));
      }
    } catch (e) {
      console.error('FLEx parse failed:', e);
      notifyError(humanizeError(e), flextext ? 'Could not read files' : 'Could not read backup');
      setStage('pick');
    }
  };

  // A resume is the same import again, so the screen is given the answers the
  // first run was given: the record carries them, and the file is read again
  // here to check them against. Without this a resume sent the defaults, which
  // could write the wrong orthography, leave out a language the first run kept
  // (and then fail on a field that is missing), or import the texts that were
  // unticked.
  const resumeChoices = resumeRecord?.choices ?? null;
  const choicesApplied = useRef(false);
  useEffect(() => {
    if (!parsed || !resumeChoices || choicesApplied.current) return;
    choicesApplied.current = true;
    const known = (list, available) => new Set((list || []).filter((x) => available.has(x)));
    setSelectedTexts(
      known(resumeChoices.texts, new Set(parsed.build.documents.map((d) => d.guid))),
    );
    setSelectedWss(known(resumeChoices.analysisWss, new Set(parsed.analysisWssAvailable)));
    if ((parsed.ir.posWss ?? []).includes(resumeChoices.posWs)) setPosWs(resumeChoices.posWs);
    setSelectedLexFields(
      known(resumeChoices.lexiconFields, new Set(parsed.ir.lexiconFields.map((f) => f.name))),
    );
    if (resumeChoices.orthoNames) {
      setOrthoNames((prev) => ({ ...prev, ...resumeChoices.orthoNames }));
    }
    setImportVariants(!!resumeChoices.importVariants);
  }, [parsed, resumeChoices]);

  // The selection knobs (texts, analysis languages) feed straight into the
  // derived config so the review cards always show what will be created.
  const filteredBuild = useMemo(
    () =>
      parsed && {
        ...parsed.build,
        documents: parsed.build.documents.filter((d) => selectedTexts.has(d.guid)),
      },
    [parsed, selectedTexts],
  );
  const liveConfig = useMemo(
    () =>
      parsed &&
      deriveImportConfig(parsed.ir, filteredBuild, {
        analysisWss: [...selectedWss],
        posWs,
        lexiconFields: [...selectedLexFields],
        // A resume heals what an earlier run left unplaced; a fresh import
        // into a lexicon already arranged leaves that arrangement alone.
        resume: !!resumeId,
      }),
    [parsed, filteredBuild, selectedWss, posWs, selectedLexFields, resumeId],
  );

  // Entries FLEx marks as a variant of, or a complex form built from, others.
  const variantEntryCount = (parsed?.ir.lexicon ?? []).filter((e) => e.entryRefs.length).length;

  const defaultLexiconName = `${projectName.trim()} Lexicon`;
  const effectiveLexiconName = lexiconName ?? defaultLexiconName;
  const existingVocab = existingVocabs.find((v) => v.id === existingVocabId) ?? null;
  const lexiconChoiceValid =
    flextext || (lexiconMode === 'existing' ? !!existingVocab : !!effectiveLexiconName.trim());

  const startImport = () => {
    const vocabName = flextext
      ? null
      : lexiconMode === 'existing'
        ? existingVocab.name
        : effectiveLexiconName.trim();

    const config = {
      ...liveConfig,
      orthographies: liveConfig.orthographies.map((o) => ({
        ws: o.ws,
        name: (orthoNames[o.ws] || o.ws).trim() || o.ws,
      })),
      variants: importVariants,
    };

    // With no lexicon to import, the documents take the bar from setup on.
    const docsFrom = flextext ? 10 : 30;
    return start({
      source: parsed.sourceName,
      setupShare: 0.1,
      // The answers this screen was given, so a resume writes the same shape
      // rather than the defaults it would pick for itself.
      choices: {
        texts: [...selectedTexts],
        analysisWss: [...selectedWss],
        posWs,
        lexiconFields: [...selectedLexFields],
        orthoNames,
        importVariants,
      },
      setupData: () =>
        setupDataFor({
          projectName: projectName.trim(),
          orthographies: config.orthographies.map((o) => o.name),
          // `ws` is the writing system this field's values are in, which is
          // what `lang` means on a field everywhere outside this importer. It
          // is recorded on the layer, so the FLEx exporters can tag each field
          // exactly instead of reading it back out of the field's name.
          fields: config.fields.map((f) => ({ name: f.name, scope: f.scope, lang: f.ws ?? null })),
          vocabularies: flextext
            ? []
            : [
                lexiconMode === 'existing'
                  ? { id: existingVocab.id, name: vocabName, isCustom: false }
                  : { id: 'new-flex-lexicon', name: vocabName },
              ],
          documentMetadata: config.documentMetadata.map((m) => m.name),
        }),
      // The lexicon the record names. A resume writes into the one its record
      // already names: setup returned early for a project already set up, so
      // a choice made on this screen would name a vocabulary the project is
      // never linked to. Otherwise it is the choice made here, or the one
      // setup just created. Read before the record is written, since writing
      // it replaces the whole value.
      vocabId: async ({ projectId, setup }) => {
        if (flextext) return null;
        const chosen = resumeId
          ? null
          : lexiconMode === 'existing'
            ? existingVocab.id
            : (setup?.resources.vocabularies?.[0]?.id ?? null);
        if (chosen) return chosen;
        const project = await client.projects.get(projectId);
        const vocabs = project.vocabs || [];
        // The record's lexicon only if the project still carries it: one
        // deleted since would be written into forever, request after request.
        // Failing that, the name this screen computes from the backup's file
        // name, which a run that renamed the lexicon leaves nothing matching.
        const recorded = readImportState(project.config)?.vocabId;
        return (
          (vocabs.some((v) => v.id === recorded) ? recorded : null) ??
          vocabs.find((v) => v.name === vocabName)?.id ??
          null
        );
      },
      requireVocab: flextext ? null : 'The lexicon this import writes into is not on the project.',
      run: ({ projectId, vocabId, shouldStop, setProgress }) => {
        const totalDocs = filteredBuild.documents.length;
        return runImport({
          operation: fmt.operation,
          client,
          projectId,
          build: filteredBuild,
          lexicon: parsed.ir.lexicon,
          config,
          vocabId,
          shouldStop,
          onProgress: (p) => {
            if (p.phase === 'lexicon') {
              setProgress({
                label: `Importing lexicon (${p.done}/${p.total})`,
                pct: 10 + (p.total ? (p.done / p.total) * 20 : 20),
              });
            } else if (p.phase === 'document') {
              setProgress({
                label: documentLabel(p, totalDocs),
                pct: docsFrom + documentFraction(p, totalDocs) * (100 - docsFrom),
              });
            }
          },
        });
      },
    });
  };

  const totalWarnings = parsed?.build.stats.warnings ?? 0;
  const warningSamples = parsed
    ? parsed.build.documents.flatMap((d) => d.warnings.map((w) => `${d.name}: ${w}`)).slice(0, 8)
    : [];
  // Parser-level warnings: references inside the backup that couldn't be
  // resolved (missing objects, unexpected analysis classes) — distinct from the
  // alignment warnings above, and a sign some data silently didn't come across.
  const irWarnings = parsed?.ir.warnings ?? [];
  const irWarningSamples = irWarnings.slice(0, 8);
  // Selections lock once setup has run: a resume must re-target the same
  // project shape, and the engine skips/redoes per document by name.
  const locked = stage !== 'review' || setupDoneRef.current || !!resumeId;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex flex-col gap-6">
        <nav className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/projects" className="hover:text-foreground hover:underline">
            Projects
          </Link>
          <span>/</span>
          <Link to="/projects/new" className="hover:text-foreground hover:underline">
            New Project
          </Link>
          <span>/</span>
          <span>{fmt.title}</span>
        </nav>

        <div>
          <h1 className="text-2xl font-bold">{fmt.title}</h1>
          {flextext ? (
            <p className="text-sm text-muted-foreground">
              Create a project from FLEx interlinear texts (<code>.flextext</code>). Texts, glosses,
              morpheme analyses, and translations are imported. The lexicon, media, and time
              alignment are not.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Create a project from a FieldWorks backup (<code>.fwbackup</code>). Texts, glosses,
              morpheme analyses, translations, and the full lexicon are imported. Media (audio and
              pictures) is not yet imported.
            </p>
          )}
          {resumeId && (
            <p className="mt-2 text-sm">
              Continuing the unfinished import into{' '}
              <span className="font-medium">{resumeName ?? 'this project'}</span>. {fmt.again}{' '}
              <button
                type="button"
                onClick={finishAsIs}
                className="font-medium text-primary hover:underline"
              >
                Use the project as it is
              </button>
            </p>
          )}
        </div>

        {stage === 'pick' && (
          <div
            className="flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed p-12 text-center hover:bg-muted/50"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleFiles(e.dataTransfer.files);
            }}
          >
            <Upload className="h-8 w-8 text-muted-foreground" />
            <p className="font-medium">{fmt.drop}</p>
            <p className="text-sm text-muted-foreground">{fmt.where}</p>
            <input
              ref={fileInputRef}
              type="file"
              accept={fmt.accept}
              multiple={flextext}
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
          </div>
        )}

        {stage === 'parsing' && (
          <div className="flex items-center justify-center gap-3 rounded-lg border bg-card p-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
            <p className="text-sm text-muted-foreground">{fmt.reading}</p>
          </div>
        )}

        {(stage === 'review' || stage === 'running' || stage === 'done') && parsed && (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border bg-card p-4">
              <p className="mb-2 font-medium">
                {parsed.fileCount > 1
                  ? `Contents of ${parsed.fileCount} files`
                  : `Contents of “${parsed.sourceName}”`}
              </p>
              <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3">
                <p>{parsed.build.stats.documents} texts</p>
                <p>{parsed.build.stats.sentences.toLocaleString()} sentences</p>
                <p>{parsed.build.stats.words.toLocaleString()} words</p>
                <p>{parsed.build.stats.morphemes.toLocaleString()} morphemes</p>
                {!flextext && (
                  <>
                    <p>{parsed.build.stats.lexiconEntries.toLocaleString()} lexicon entries</p>
                    <p>{parsed.build.stats.lexiconSenses.toLocaleString()} senses</p>
                  </>
                )}
              </div>
              {parsed.ir.unread?.length > 0 && (
                <p className="mt-2 text-sm text-muted-foreground">
                  Not imported:{' '}
                  {parsed.ir.unread
                    .map((u) => `${u.label} (${u.count.toLocaleString()})`)
                    .join(', ')}
                  .
                </p>
              )}
              {totalWarnings > 0 && (
                <div className="mt-3 rounded-md border border-orange-200 bg-orange-50 p-3 text-sm">
                  <p className="font-medium text-orange-800">
                    {totalWarnings} word{totalWarnings === 1 ? '' : 's'} could not be aligned to the
                    baseline and will be skipped:
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-orange-700">
                    {warningSamples.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                    {totalWarnings > warningSamples.length && (
                      <li>…and {totalWarnings - warningSamples.length} more</li>
                    )}
                  </ul>
                </div>
              )}
              {irWarnings.length > 0 && (
                <div className="mt-3 rounded-md border border-orange-200 bg-orange-50 p-3 text-sm">
                  <p className="font-medium text-orange-800">
                    {flextext
                      ? `${irWarnings.length} warning${irWarnings.length === 1 ? '' : 's'}:`
                      : `${irWarnings.length} reference${irWarnings.length === 1 ? '' : 's'} in the backup could not be resolved. Some data may be missing from the import:`}
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-orange-700">
                    {irWarningSamples.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                    {irWarnings.length > irWarningSamples.length && (
                      <li>…and {irWarnings.length - irWarningSamples.length} more</li>
                    )}
                  </ul>
                </div>
              )}
            </div>

            <div className="rounded-lg border bg-card p-4">
              <label className="mb-1 block text-sm font-medium" htmlFor="flex-project-name">
                Project name
              </label>
              <Input
                id="flex-project-name"
                value={resumeId ? (resumeName ?? '') : projectName}
                onChange={(e) => setProjectName(e.target.value)}
                disabled={!!resumeId || stage !== 'review' || setupDoneRef.current}
              />
              {resumeId && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Continuing an import into this project. What it already holds is kept.
                </p>
              )}
            </div>

            {!flextext && (
              <div className="rounded-lg border bg-card p-4">
                <p className="mb-1 font-medium">Lexicon</p>
                <p className="mb-3 text-sm text-muted-foreground">
                  The FLEx lexicon ({parsed.ir.lexicon.length.toLocaleString()} entries) becomes the
                  vocabulary the interlinear links to.
                </p>
                <div className="flex flex-col gap-3">
                  {resumeId ? (
                    <p className="text-sm">
                      Entries go into{' '}
                      <strong>
                        {resumedLexicon?.name ??
                          (resumeProject ? 'a lexicon no longer on the project' : '…')}
                      </strong>
                      .
                    </p>
                  ) : (
                    <>
                      <label className="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="radio"
                          name="flex-lexicon-mode"
                          checked={lexiconMode === 'new'}
                          disabled={locked}
                          onChange={() => setLexiconMode('new')}
                        />
                        Create a new lexicon
                      </label>
                      {lexiconMode === 'new' && (
                        <Input
                          id="flex-lexicon-name"
                          aria-label="Lexicon name"
                          className="ml-6 max-w-md"
                          value={effectiveLexiconName}
                          onChange={(e) => setLexiconName(e.target.value)}
                          disabled={locked}
                        />
                      )}
                      <label
                        className={`flex items-center gap-2 text-sm ${
                          existingVocabs.length ? 'cursor-pointer' : 'text-muted-foreground'
                        }`}
                      >
                        <input
                          type="radio"
                          name="flex-lexicon-mode"
                          checked={lexiconMode === 'existing'}
                          disabled={locked || existingVocabs.length === 0}
                          onChange={() => setLexiconMode('existing')}
                        />
                        Add to a lexicon you maintain
                        {existingVocabs.length === 0 && (
                          <span className="text-xs">(none available)</span>
                        )}
                      </label>
                      {lexiconMode === 'existing' && (
                        <div className="ml-6 flex flex-col gap-1.5">
                          <select
                            id="flex-lexicon-existing"
                            aria-label="Existing lexicon"
                            className="h-9 max-w-md rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                            value={existingVocabId}
                            disabled={locked}
                            onChange={(e) => setExistingVocabId(e.target.value)}
                          >
                            <option value="">Choose a lexicon…</option>
                            {existingVocabs.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.name}
                              </option>
                            ))}
                          </select>
                          <p className="text-xs text-muted-foreground">
                            Entries are added to it and its existing fields stay as they are. Senses
                            already imported from this FLEx project are reused, not duplicated.
                          </p>
                        </div>
                      )}
                    </>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    Senses are kept under their entry, in FLEx order.
                  </p>
                  {variantEntryCount > 0 && (
                    <label className="flex cursor-pointer items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={importVariants}
                        disabled={locked}
                        onChange={(e) => setImportVariants(e.target.checked)}
                      />
                      <span>
                        Variants and complex forms
                        <span className="block text-xs text-muted-foreground">
                          {variantEntryCount} {variantEntryCount === 1 ? 'entry' : 'entries'}. A
                          variant refers to its canonical form, and a complex form to what it is
                          built from.
                        </span>
                      </span>
                    </label>
                  )}
                </div>
              </div>
            )}

            <div className="rounded-lg border bg-card p-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium">
                  Texts{' '}
                  <span className="font-normal text-muted-foreground">
                    ({selectedTexts.size} of {parsed.build.documents.length} selected)
                  </span>
                </p>
                {!locked && (
                  <span className="flex gap-3 text-sm">
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground hover:underline"
                      onClick={() =>
                        setSelectedTexts(new Set(parsed.build.documents.map((d) => d.guid)))
                      }
                    >
                      all
                    </button>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground hover:underline"
                      onClick={() => setSelectedTexts(new Set())}
                    >
                      none
                    </button>
                  </span>
                )}
              </div>
              <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                {parsed.build.documents.map((d) => (
                  <label
                    key={d.guid}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted/50"
                  >
                    <input
                      type="checkbox"
                      checked={selectedTexts.has(d.guid)}
                      disabled={locked}
                      onChange={(e) =>
                        setSelectedTexts((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(d.guid);
                          else next.delete(d.guid);
                          return next;
                        })
                      }
                    />
                    <span className="flex-1 truncate">{d.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {d.sentences.length} sentences · {d.words.length.toLocaleString()} words
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {parsed.analysisWssAvailable.length > 1 && (
              <div className="rounded-lg border bg-card p-4">
                <p className="mb-1 font-medium">Analysis languages</p>
                <p className="mb-3 text-sm text-muted-foreground">
                  Glosses and translations exist in these languages. Each selected one gets its own
                  annotation fields.
                </p>
                <div className="flex flex-wrap gap-4">
                  {parsed.analysisWssAvailable.map((ws) => (
                    <label key={ws} className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedWss.has(ws)}
                        disabled={locked}
                        onChange={(e) =>
                          setSelectedWss((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(ws);
                            else next.delete(ws);
                            return next;
                          })
                        }
                      />
                      <code className="text-xs">{ws}</code>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {(parsed.ir.posWss?.length ?? 0) > 1 && (
              <div className="rounded-lg border bg-card p-4">
                <p className="mb-1 font-medium">Part-of-speech language</p>
                <p className="mb-3 text-sm text-muted-foreground">
                  Categories are named in these languages. Words, morphemes and entries take the
                  name in the one selected.
                </p>
                <div className="flex flex-wrap gap-4">
                  {parsed.ir.posWss.map((ws) => (
                    <label key={ws} className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="posWs"
                        checked={posWs === ws}
                        disabled={locked}
                        onChange={() => setPosWs(ws)}
                      />
                      <code className="text-xs">{ws}</code>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {parsed.ir.lexiconFields.length > 0 && (
              <div className="rounded-lg border bg-card p-4">
                <p className="mb-1 font-medium">Lexicon fields</p>
                <p className="mb-3 text-sm text-muted-foreground">
                  Form, gloss, part of speech, definition, morph type, examples and custom fields
                  are always imported. These other FLEx fields carry values too, and each becomes a
                  field on the lexicon entries. Untick any you do not want.
                </p>
                <div className="flex flex-col gap-2">
                  {parsed.ir.lexiconFields.map((f) => {
                    const where = [
                      f.entries > 0 &&
                        `${f.entries.toLocaleString()} entr${f.entries === 1 ? 'y' : 'ies'}`,
                      f.senses > 0 &&
                        `${f.senses.toLocaleString()} sense${f.senses === 1 ? '' : 's'}`,
                    ]
                      .filter(Boolean)
                      .join(', ');
                    return (
                      <label
                        key={f.name}
                        className="flex cursor-pointer items-center gap-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={selectedLexFields.has(f.name)}
                          disabled={locked}
                          onChange={(e) =>
                            setSelectedLexFields((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(f.name);
                              else next.delete(f.name);
                              return next;
                            })
                          }
                        />
                        <span>{humanizeFieldName(f.name)}</span>
                        <span className="text-xs text-muted-foreground">
                          {where} · <code>{f.wss.join(', ')}</code>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {liveConfig.orthographies.length > 0 && (
              <div className="rounded-lg border bg-card p-4">
                <p className="mb-1 font-medium">Orthographies</p>
                <p className="mb-3 text-sm text-muted-foreground">
                  The baseline text is in {parsed.build.baselineWs}. Other writing systems on words
                  become orthographies. Rename them if you like.
                </p>
                <div className="flex flex-col gap-2">
                  {liveConfig.orthographies.map((o) => (
                    <div key={o.ws} className="flex items-center gap-3">
                      <code className="w-56 shrink-0 truncate text-xs text-muted-foreground">
                        {o.ws}
                      </code>
                      <Input
                        value={orthoNames[o.ws] ?? o.ws}
                        onChange={(e) =>
                          setOrthoNames((prev) => ({ ...prev, [o.ws]: e.target.value }))
                        }
                        disabled={locked}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="rounded-lg border bg-card p-4">
              <p className="mb-2 font-medium">Annotation fields</p>
              <div className="flex flex-wrap gap-2">
                {liveConfig.fields.map((f) => (
                  <Badge key={`${f.scope}:${f.name}`} className={scopeBadgeClass(f.scope)}>
                    {f.name} · {f.scope}
                  </Badge>
                ))}
              </div>
            </div>

            {runError && stage === 'review' && (
              <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4 text-sm">
                <div className="flex items-start gap-2">
                  <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div>
                    <p className="font-medium text-destructive">
                      {runError === 'Import cancelled' ? 'Import stopped' : 'Import failed'}
                    </p>
                    {runError !== 'Import cancelled' && (
                      <p className="mt-1 text-muted-foreground">{runError}</p>
                    )}
                    {projectIdRef.current && (
                      <p className="mt-1 text-muted-foreground">
                        Progress so far is kept. Importing again resumes where it stopped.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {stage === 'review' && (
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setParsed(null);
                    setStage('pick');
                  }}
                  disabled={setupDoneRef.current}
                >
                  Choose another file
                </Button>
                <Button
                  onClick={startImport}
                  disabled={!projectName.trim() || selectedTexts.size === 0 || !lexiconChoiceValid}
                >
                  {projectIdRef.current ? (
                    <>
                      <RefreshCw className="h-4 w-4" /> Resume Import
                    </>
                  ) : (
                    <>
                      <FileUp className="h-4 w-4" /> Import {selectedTexts.size} text
                      {selectedTexts.size === 1 ? '' : 's'}
                    </>
                  )}
                </Button>
              </div>
            )}

            {stage === 'running' && (
              <div className="rounded-lg border bg-card p-4">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
                    <p className="font-medium">Importing…</p>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${progress?.pct ?? 0}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm text-muted-foreground">
                      {progress?.label ?? 'Starting…'}
                    </p>
                    <Button variant="outline" size="sm" onClick={stop}>
                      <Square className="h-3.5 w-3.5" /> Stop
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {stage === 'done' && (
              <div className="rounded-md border border-border bg-muted p-4">
                <div className="flex items-start gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                  <div className="text-sm">
                    <p className="font-medium">Import complete</p>
                    <p className="mt-1 text-muted-foreground">
                      {results?.imported ?? 0} imported
                      {results?.skipped ? `, ${results.skipped} already present` : ''}
                      {results?.redone ? `, ${results.redone} redone` : ''}.
                    </p>
                    <Button className="mt-3" asChild>
                      <Link to={`/projects/${projectIdRef.current}`}>Open project</Link>
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
