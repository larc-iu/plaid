import { ProjectGeneralPage } from '@ui/components/shared/ProjectGeneralPage.jsx';
import { Card, CardContent } from '@ui/components/ui/card';
import { LanguagesSettings } from './LanguagesSettings.jsx';
import { VocabulariesStay } from './VocabulariesStay.jsx';

// What the project IS: its name and the languages it documents, on the page
// every app shares (name, the app's sections, delete). Document Metadata used
// to sit here, on the argument that Date and Speakers describe a text rather
// than its structure. It moved to Annotation once its fields could be governed
// by tagsets: they are now configured exactly like annotation fields, and
// configuration is what this screen is for.
//
// IGT keeps two languages (object and meta), so it passes its own section
// instead of the shared single-tag Language card. The Delete project confirm
// names the vocabularies that stay (VocabulariesStay).
export const GeneralSettings = ({ project, projectId, client, onProjectUpdate }) => (
  <ProjectGeneralPage
    project={project}
    onSaved={onProjectUpdate}
    research
    deleteNote={
      project?.vocabs?.length ? <VocabulariesStay project={project} client={client} /> : null
    }
  >
    <Card>
      <CardContent className="pt-6">
        <LanguagesSettings
          project={project}
          projectId={projectId}
          client={client}
          onProjectUpdate={onProjectUpdate}
        />
      </CardContent>
    </Card>
  </ProjectGeneralPage>
);
