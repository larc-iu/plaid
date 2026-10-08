import { Fragment } from 'react';
import { ChevronRight, Table2 } from 'lucide-react';
import { Turn } from './Turn.jsx';
import { AssistantMark } from './PlaidMarks.jsx';
import { ExportContext } from './exportContext.js';
import { turnContext } from './transcript.js';

// A table the reply made, as the export shows it under the file's chip: open
// when it is short, folded when it is not.
const OPEN_ROWS = 20;
const FileTable = ({ file, table }) => (
  <details open={table.rows.length <= OPEN_ROWS} className="text-xs">
    <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded px-1 py-0.5 text-muted-foreground">
      <ChevronRight className="plaid-export-chevron h-3 w-3" />
      <Table2 className="h-3 w-3" />
      <span>
        <bdi>{file.name}</bdi>
        {`, ${table.rows.length === 1 ? '1 row' : `${table.rows.length} rows`}`}
      </span>
    </summary>
    <div className="mt-1 max-h-96 overflow-auto rounded border">
      <table className="plaid-export-table">
        <thead>
          <tr>
            {table.header.map((h, i) => (
              <th key={i} dir="auto">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i}>
              {table.header.map((_, j) => (
                <td key={j} dir="auto" className="font-text">
                  {r[j] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </details>
);

// A conversation as one static web page (exportHtml.js renders it to a
// string): a header naming it, then every turn drawn by the chat's own `Turn`,
// read-only, as the admin area's transcript draws it. `facts` are the header's
// lines, `left` what the page does not include, `tables` the made tables it
// does, by file id.
export const ExportPage = ({
  title,
  facts,
  left,
  display,
  results,
  tables,
  projectId,
  projectName,
  adapter,
  model,
}) => (
  <ExportContext.Provider
    value={{
      fileBody: (f) => (tables.has(f.id) ? <FileTable file={f} table={tables.get(f.id)} /> : null),
    }}
  >
    <main className="plaid-export">
      <header className="plaid-export-header">
        <h1 dir="auto">{title}</h1>
        <p className="text-sm text-muted-foreground">
          {facts.map((f, i) => (
            <Fragment key={i}>
              {i > 0 && <span aria-hidden="true"> · </span>}
              <span>{f}</span>
            </Fragment>
          ))}
        </p>
        {left && <p className="mt-1 text-sm text-muted-foreground">{left}</p>}
      </header>
      <section className="flex min-w-0 flex-col rounded-lg border bg-card">
        <header className="flex min-h-14 flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
          <AssistantMark className="h-4 w-4 shrink-0" />
          {model && <span className="font-medium">{model}</span>}
        </header>
        <div className="px-4 py-4">
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            {display.length === 0 && <p className="text-sm text-muted-foreground">No messages.</p>}
            {display.map((d, i) => (
              <Turn
                key={i}
                item={d}
                projectId={projectId}
                adapter={adapter}
                results={results}
                {...turnContext(display, i)}
                homeName={projectName}
                canWrite={false}
                busy={false}
                interrupted={!!d.interrupted}
                applying={false}
                readOnly
              />
            ))}
          </div>
        </div>
      </section>
    </main>
  </ExportContext.Provider>
);
