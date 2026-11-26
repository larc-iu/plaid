import { t, tx } from '@ui/lib/i18n.js';
import { FRAME_LANGUAGES, framesFor } from '../../domain/lexicon.js';
import { UMR_NAMESPACE, readProjectLanguage } from '../../utils/umrLayerUtils.js';
import { useManagedProject } from '@ui/hooks/useManagedProject.js';
import { ProjectGeneralPage } from '@ui/components/shared/ProjectGeneralPage.jsx';
import { Loading } from '@ui/components/shared/Loading.jsx';

// The languages with a bundled frame file, for the line that says a project's
// has none. Named rather than listed as tags: a tag is what you type, a name
// is what you recognize. Built when shown, in the page's language.
const bundledNames = () =>
  Object.values(FRAME_LANGUAGES)
    .map((f) => t(f.name))
    .join(', ');

// Which rolesets the SAVED language gets, not the typed one: the line reports
// what the concept editor is offering now. Four languages have a bundled file
// and every other one has none, which the concept editor showed only as an
// empty Senses group.
const rolesetNote = (savedLanguage) => {
  const frames = framesFor(savedLanguage);
  if (frames)
    return t('Bundled rolesets: {name}, {n, number}.', {
      name: t(frames.name),
      n: frames.rolesets,
    });
  if (savedLanguage)
    return tx('No bundled rolesets for <code>{language}</code>. Bundled: {names}.', {
      language: savedLanguage,
      names: bundledNames(),
      code: (c) => <code>{c}</code>,
    });
  return t('Bundled rolesets: {names}.', { names: bundledNames() });
};

// "General": the shared page (name, language, delete). UMR adds what the saved
// language means for the concept editor's rolesets.
//
// `onProjectUpdate` refreshes the parent's copy of the project. The name shows
// in the breadcrumb above this screen and in the project list, so a rename that
// only refreshed this tab would leave both stale until a reload.
export const ProjectGeneralSettings = ({ onProjectUpdate }) => {
  const { project, loading, fetchProject, canConfigure } = useManagedProject();

  // Only the first load shows the line: a refetch after a save keeps the page
  // up, so a field being typed in is not taken away under the reader.
  if (!project) return loading ? <Loading /> : null;
  if (!canConfigure) return null;

  const refresh = async () => {
    await fetchProject();
    onProjectUpdate?.();
  };

  return (
    <ProjectGeneralPage
      project={project}
      onSaved={refresh}
      research
      language={{
        // The tag is on the PROJECT, in this app's half of its config.
        namespace: UMR_NAMESPACE,
        saved: readProjectLanguage(project),
        description: tx(
          'The language this project annotates, as a BCP-47 tag (<code>en</code>, <code>zh</code>, <code>arp</code>).',
          { code: (c) => <code>{c}</code> },
        ),
        note: rolesetNote,
      }}
    />
  );
};
