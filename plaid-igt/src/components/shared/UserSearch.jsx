import { Badge } from '@/components/ui/badge';
import { SearchInput, ListHint } from '@/components/ui/list-search';
import { UserAvatar } from '@/components/shared/UserAvatar';
import { USER_SEARCH_LIMIT } from '@/hooks/useUserSearch';

// The search box and its results wherever someone is picked out of the user
// directory to be added. `search` is a useUserSearch, and `renderAction(u)`
// is the control that adds the person on that row.
export const UserSearch = ({ client, search, renderAction }) => {
  const { query, setQuery, debounced, active, activate, results, loading, denied, capped } = search;
  return (
    <div className="flex flex-col gap-2">
      <SearchInput
        placeholder="Search users by name…"
        value={query}
        onChange={setQuery}
        onFocus={activate}
      />

      {denied ? (
        <p className="py-1 text-sm text-muted-foreground">
          You cannot browse the user directory. Only an administrator or a project maintainer can
          add users here.
        </p>
      ) : (
        active &&
        (loading ? (
          <div className="flex justify-center py-4 text-muted-foreground">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
          </div>
        ) : results.length === 0 ? (
          <p className="py-1 text-sm text-muted-foreground">
            {debounced ? 'No matching users.' : 'No other users to add.'}
          </p>
        ) : (
          <div className="flex flex-col">
            {results.map((u, i) => (
              <div
                key={u.id}
                className={`flex items-center justify-between gap-2 py-2 ${i ? 'border-t' : ''}`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <UserAvatar
                    client={client}
                    userId={u.id}
                    displayName={u.displayName}
                    avatarHash={u.avatarHash}
                    className="h-7 w-7"
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{u.displayName}</span>
                      {u.isAdmin && <Badge variant="secondary">Admin</Badge>}
                    </div>
                    <span className="block truncate text-xs text-muted-foreground">{u.id}</span>
                  </div>
                </div>
                {renderAction(u)}
              </div>
            ))}
            {capped && (
              <ListHint className="pt-2">
                Showing the first {USER_SEARCH_LIMIT} matches. Keep typing to narrow the list.
              </ListHint>
            )}
          </div>
        ))
      )}
    </div>
  );
};
