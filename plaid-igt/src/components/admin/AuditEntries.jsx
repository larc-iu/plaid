import { Link } from 'react-router-dom';
import { timeAgo, fullTimestamp } from '@/utils/formatTime';

// One audit feed, rendered the same way wherever it is shown. An entry is a
// folded unit: a group or a batch stands for the whole action, so the row says
// what the person did, not how many rows it took.

// A unit's label, best available: the operation group's own message ("Confirm
// word analysis"), else the first operation's description, else its type.
const label = (entry) => {
  if (entry.message) return entry.message;
  const head = entry.ops?.[0];
  return head?.description || head?.type || 'Change';
};

export const AuditEntries = ({ entries, empty = 'Nothing yet.', showUser = false }) => {
  if (!entries || entries.length === 0) {
    return <p className="p-3 text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <table className="w-full text-sm">
      <tbody>
        {entries.map((entry) => {
          const project = entry.projects?.[0];
          const document = entry.documents?.[0];
          return (
            <tr key={entry.id} className="border-b last:border-0">
              <td
                className="whitespace-nowrap px-3 py-1.5 text-muted-foreground"
                title={fullTimestamp(entry.time)}
              >
                {timeAgo(entry.time)}
              </td>
              {showUser && (
                <td className="px-3 py-1.5">{entry.user?.displayName || entry.user?.id || '—'}</td>
              )}
              <td className="px-3 py-1.5">{label(entry)}</td>
              <td className="px-3 py-1.5 text-muted-foreground">
                {document && project ? (
                  <Link
                    to={`/projects/${project.id}/documents/${document.id}`}
                    className="hover:underline"
                  >
                    {document.name}
                  </Link>
                ) : project ? (
                  <Link to={`/projects/${project.id}`} className="hover:underline">
                    {project.name}
                  </Link>
                ) : (
                  ''
                )}
              </td>
              <td className="px-3 py-1.5 text-right text-xs text-muted-foreground tabular-nums">
                {entry.apiToken ? entry.apiToken.name : ''}
                {entry.ops?.length > 1 ? ` ${entry.ops.length} writes` : ''}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};
