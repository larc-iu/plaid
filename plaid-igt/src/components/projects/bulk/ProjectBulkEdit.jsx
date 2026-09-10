import { useMemo } from 'react';
import { Replace, ReplaceAll, Wand2, Merge } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useTabParam } from '@/hooks/useTabParam';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { OPERATIONS } from './bulkPlan.js';
import { FieldPanel } from './FieldPanel.jsx';
import { MergePanel } from './MergePanel.jsx';
import { ReanalyzePanel } from './ReanalyzePanel.jsx';
import { RespellPanel } from './RespellPanel.jsx';
import { Change } from './parts.jsx';

// The Bulk Edit workbench: pick an operation, describe the change, preview
// every match as a checkbox row (grouped by document, each row a link into
// the editor), then apply the ticked rows under one audit operation. The
// shape is FLEx's Change Spelling / Bulk Edit dialogs — filter, tick, preview,
// apply — with the Search tab's matching underneath.
//
// Everything that touches the server lives in bulkRunner.js; the row shapes
// and match logic in bulkPlan.js. This file is the forms, the row list, and
// the confirm step.

const ICONS = { respell: Replace, field: ReplaceAll, reanalyze: Wand2, merge: Merge };

const PANELS = {
  respell: RespellPanel,
  field: FieldPanel,
  reanalyze: ReanalyzePanel,
  merge: MergePanel,
};

const OP_IDS = OPERATIONS.map((o) => o.id);

// Same layout as the Settings tab: the activities as a vertical tab list on
// the left, the chosen activity (with its own title and explainer) on the
// right. The activity rides in `?op=` next to `?tab=bulk`, so a reload or a
// shared link lands on the same one.
export const ProjectBulkEdit = ({ project, projectId, client }) => {
  const layerInfo = useMemo(() => getIgtLayerInfo(project), [project]);
  const [op, setOp] = useTabParam(OP_IDS, 'respell', 'op');

  if (!layerInfo.primaryTokenLayer) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        This project has no word layer to edit.
      </p>
    );
  }

  const panelProps = { project, projectId, client, layerInfo };
  return (
    <Tabs
      orientation="vertical"
      value={op}
      onValueChange={setOp}
      className="flex flex-col gap-6 sm:flex-row sm:items-start"
    >
      <TabsList className="h-auto w-full shrink-0 flex-col items-stretch justify-start gap-0.5 border-b-0 bg-transparent p-0 sm:w-52 sm:border-r sm:pr-3">
        {OPERATIONS.map((o) => {
          const Icon = ICONS[o.id];
          return (
            <TabsTrigger
              key={o.id}
              value={o.id}
              to={`/projects/${projectId}?tab=bulk${o.id === 'respell' ? '' : `&op=${o.id}`}`}
              className="w-full justify-start gap-2 rounded-md border-b-0 px-3 py-2 data-[state=active]:bg-muted data-[state=active]:text-foreground"
            >
              <Icon className="h-4 w-4 shrink-0" /> {o.label}
            </TabsTrigger>
          );
        })}
      </TabsList>

      <div className="min-w-0 flex-1">
        {OPERATIONS.map((o) => {
          const Panel = PANELS[o.id];
          return (
            <TabsContent key={o.id} value={o.id} className="mt-0">
              <div className="mb-4">
                <h2 className="text-lg font-semibold">{o.label}</h2>
                <p className="text-sm text-muted-foreground">{o.blurb}</p>
              </div>
              {op === o.id && <Panel {...panelProps} />}
            </TabsContent>
          );
        })}
      </div>
    </Tabs>
  );
};
