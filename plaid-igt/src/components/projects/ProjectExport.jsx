import { ExportRunner } from '@/components/export/ExportRunner.jsx';
import { ExportPresetsSettings } from './settings/ExportPresetsSettings';
import { ExportPresetEditor } from './settings/ExportPresetEditor';

// The project's Export tab.
//
// For a maintainer it is two pages, one path each:
//
//   /projects/:id/export             the list of presets, plus New preset
//   /projects/:id/export/:presetId   one preset: edit it, save it, run it
//
// Running lives inside the preset's own page, at the bottom, because picking
// what to export and picking how are one decision. The list stays a list, so
// the presets are never enumerated twice on one screen.
//
// A reader cannot edit presets, so there is nothing to list them for: they get
// the run controls directly, choosing a preset from the ones that exist. That
// is the capability they had before this tab existed.
export const ProjectExport = ({
  project,
  projectId,
  client,
  documents,
  canManage,
  presetId = null,
  onProjectUpdate,
}) => {
  if (!canManage) {
    return (
      <div className="tw pt-4">
        <ExportRunner
          client={client}
          project={project}
          documents={documents}
          showPresetsLink={false}
        />
      </div>
    );
  }
  return presetId ? (
    <ExportPresetEditor
      projectId={projectId}
      client={client}
      presetId={presetId}
      onProjectUpdate={onProjectUpdate}
    />
  ) : (
    <ExportPresetsSettings
      projectId={projectId}
      client={client}
      onProjectUpdate={onProjectUpdate}
    />
  );
};
