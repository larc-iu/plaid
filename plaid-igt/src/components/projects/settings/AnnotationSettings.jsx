import { readTagsets } from '@/domain/tagsets';
import { TagsetsSettings } from './TagsetsSettings.jsx';
import { FieldsSettings } from './FieldsSettings.jsx';

// The interlinear structure: which tiers exist, what values they may take, and
// which tokens are skipped. The three belong together because they refer to
// each other — a field points at a tagset by name, and the ignored-token rule
// (rendered inside FieldsSettings) only affects Word-scope fields.
export const AnnotationSettings = ({ project, projectId, client, onProjectUpdate }) => {
  // Read here rather than in FieldsSettings: the two sections are siblings, so
  // a tagset created above has to reach the field table below without a page
  // reload, and this component is the one holding the live project.
  const tagsetNames = Object.keys(readTagsets(project?.config));

  return (
    <div className="tw flex flex-col gap-8 pt-4 [&>*+*]:border-t [&>*+*]:pt-8">
      {/* Tagsets: the value lists the fields below can point at. Above
          Annotation Fields because a field can only reference one that
          already exists. */}
      <TagsetsSettings
        project={project}
        projectId={projectId}
        client={client}
        onProjectUpdate={onProjectUpdate}
      />

      {/* Annotation Fields, and the ignored-token rule that modifies the
          Word-scope ones. Both live in FieldsSettings and save together. */}
      <FieldsSettings
        projectId={projectId}
        client={client}
        tagsetNames={tagsetNames}
        onProjectUpdate={onProjectUpdate}
      />
    </div>
  );
};
