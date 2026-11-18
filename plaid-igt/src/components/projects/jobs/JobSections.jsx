import { Link } from 'react-router-dom';
import { ListPager } from '@ui/components/shared/list-search.jsx';
import { TYPE } from '@ui/lib/typeScale.js';
import { TALL_LIST_PAGE_SIZE, usePagedList } from '@ui/hooks/usePagedList.js';
import {
  AssistantSummary,
  BlankDocument,
  Entries,
  HarmonizeChanged,
  HarmonizeLeft,
  Heading,
  JobFindings,
  LeftOut,
  ProposedChanges,
  Respelled,
  SkippedDocument,
  Tables,
  TotalsList,
} from './JobReport.jsx';
import { blankDocuments, noticeOf, skippedDocuments } from './jobTotals.js';
import { jobHeadline, toCheckRows } from './jobOverview.js';

// The job page's sections past its Overview that list what the report holds,
// one each (`?view=`), and the report's part of the Overview of an ended job.

// A list on the shared pager, its page in the address (`?page=`), the pager
// above and below the rows inside the list's own border. `children` draws the
// rows of one page.
const Paged = ({ items, pageSize = TALL_LIST_PAGE_SIZE, children, className = 'max-w-3xl' }) => {
  const paged = usePagedList(items, { pageSize, urlParam: 'page' });
  return (
    <div className={`rounded-md border bg-card ${className}`}>
      <ListPager {...paged} onPage={paged.setPage} position="top" />
      <div className="px-3 py-2">{children(paged.pageItems)}</div>
      <ListPager {...paged} onPage={paged.setPage} position="bottom" />
    </div>
  );
};

// Documents with their skipped sentences, a page of them at a time.
const SkippedSection = ({ report, projectId }) => (
  <>
    <Heading section="skipped" />
    <Paged items={skippedDocuments(report)}>
      {(docs) =>
        docs.map((d) => <SkippedDocument key={d.documentId} d={d} projectId={projectId} />)
      }
    </Paged>
  </>
);

// Documents with what is left blank in them, a page of them at a time.
const BlankSection = ({ report, projectId }) => (
  <>
    <Heading section="left" />
    <Paged items={blankDocuments(report)}>
      {(docs) => docs.map((d) => <BlankDocument key={d.documentId} d={d} projectId={projectId} />)}
    </Paged>
  </>
);

const ConsistentSection = ({ report }) => (
  <>
    <Heading section="harmonize.changed" />
    <Paged items={report.harmonize?.changed || []} className="">
      {(list) => <HarmonizeChanged list={list} more={report.harmonize?.changedMore} />}
    </Paged>
  </>
);

const InconsistentSection = ({ report }) => (
  <>
    <Heading section="harmonize.left" />
    <Paged items={report.harmonize?.left || []} className="">
      {(list) => <HarmonizeLeft list={list} more={report.harmonize?.leftMore} />}
    </Paged>
  </>
);

// The body of each list's section, by its `?view=`.
const SECTION_BODIES = {
  blank: BlankSection,
  skipped: SkippedSection,
  proposed: ({ report, projectId }) => <ProposedChanges report={report} projectId={projectId} />,
  entries: ({ report, vocabs }) => <Entries report={report} vocabs={vocabs} />,
  respelled: ({ report, projectId }) => <Respelled report={report} projectId={projectId} />,
  leftout: ({ report, projectId }) => <LeftOut report={report} projectId={projectId} />,
  tables: ({ report }) => <Tables tables={report.tables || []} more={report.tablesMore || 0} />,
  consistent: ConsistentSection,
  inconsistent: InconsistentSection,
};

// One of the report's lists, as its section.
export const ReportSection = ({ view, report, projectId, vocabs }) => {
  const Body = SECTION_BODIES[view];
  if (!Body) return null;
  return (
    <section aria-label="Report" className="[&>h3:first-child]:mt-0">
      <Body report={report} projectId={projectId} vocabs={vocabs} />
    </section>
  );
};

// What needs a person, a row per kind with its count, each with a link to the
// section that lists it. "Nothing." when nothing does.
const ToCheck = ({ rows, sectionHref, sections }) => (
  <>
    <h3 className={`${TYPE.card} mb-2 mt-6`}>To check</h3>
    {rows.length ? (
      <ul
        className="max-w-3xl divide-y rounded-md border bg-card text-sm"
        data-testid="job-to-check"
      >
        {rows.map((r) => (
          <li
            key={r.key}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2"
          >
            <span>{r.text}</span>
            {r.view && sections.includes(r.view) && (
              <Link
                to={sectionHref(r.view, r.filter)}
                className="shrink-0 text-primary hover:underline"
                aria-label={`Show: ${r.text}`}
              >
                Show
              </Link>
            )}
          </li>
        ))}
      </ul>
    ) : (
      <p className="text-sm text-muted-foreground">Nothing.</p>
    )}
  </>
);

// The report's part of an ended job's Overview: the one sentence of what it
// changed, its notice, a fills-nothing job's findings, what to check, the
// totals and the assistant's summary.
export const ReportOverview = ({ job, sectionHref, sections }) => {
  const report = job.report;
  const notice = report && !job.undone ? noticeOf(report) : null;
  const findings = typeof report?.findings === 'string' ? report.findings : '';
  return (
    <section aria-label="Report" className="mt-6">
      <p className="max-w-3xl text-base font-medium" data-testid="job-headline">
        {jobHeadline(job)}
      </p>
      {report?.stopped === 'without-worker' && (
        <p className="mt-1 text-sm text-muted-foreground">Stopped with no worker running.</p>
      )}
      {/* The worker's own line, from its counts, where the job changed
          people's work or the text (R4). */}
      {notice && (
        <p className="mt-1 max-w-3xl text-sm" data-testid="job-notice">
          {notice}
        </p>
      )}
      {report?.summary && report.summaryBy === 'worker' && (
        <p className="mt-1 max-w-3xl text-sm" data-testid="job-summary">
          {report.summary}
        </p>
      )}
      {/* The one report of a job that fills nothing (RP-4). */}
      {findings && (
        <JobFindings findings={findings} pieces={report.findingsPieces} cut={report.findingsCut} />
      )}
      {/* An undone job's writes are taken back: nothing of them is to check. */}
      {!job.undone && (
        <ToCheck rows={toCheckRows(job)} sectionHref={sectionHref} sections={sections} />
      )}
      {report && <TotalsList report={report} undone={job.undone ?? null} />}
      {report && <AssistantSummary report={report} />}
    </section>
  );
};
