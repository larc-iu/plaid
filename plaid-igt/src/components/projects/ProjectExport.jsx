import { ExportRunner } from '@/components/export/ExportRunner.jsx';
import { ExportPresetsSettings } from './settings/ExportPresetsSettings';
import { ExportPresetEditor } from './settings/ExportPresetEditor';

// The project's Export tab: run an export at the top, manage the presets it
// runs with underneath. Both used to live apart (a modal on the Documents tab
// for running, a Settings section for configuring), which meant configuring a
// preset and using it were two different places.
//
// Path-backed like Settings: /projects/:id/export is this page and
// /projects/:id/export/:presetId is one preset's editor, so a preset is
// linkable and the back button works through it.
//
// A reader can run an export but not change what the presets are, so the
// management half is maintainer-only. The per-document Export tab is separate
// and unaffected (see DocumentDetail).
export const ProjectExport = ({
  project,
  projectId,
  client,
  documents,
  canManage,
  presetId = null,
  onProjectUpdate,
}) => {
  if (presetId) {
    return (
      <ExportPresetEditor
        projectId={projectId}
        client={client}
        presetId={presetId}
        onProjectUpdate={onProjectUpdate}
      />
    );
  }

  return (
    <div className="tw flex flex-col gap-10 pt-4">
      <ExportRunner
        client={client}
        project={project}
        documents={documents}
        canManage={canManage}
        showPresetsLink={false}
      />
      {canManage && (
        <div className="border-t pt-2">
          <ExportPresetsSettings
            projectId={projectId}
            client={client}
            onProjectUpdate={onProjectUpdate}
          />
        </div>
      )}
    </div>
  );
};
