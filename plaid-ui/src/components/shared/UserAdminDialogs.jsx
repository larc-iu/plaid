import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle } from '../ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '../ui/alert-dialog';
import { MintedLinkDialog } from './MintedLinkDialog.jsx';

// The dialogs behind useUserAdmin (its own module): one copy of the create,
// edit, deactivate, and reset-link screens, wherever accounts are managed.
//
// Every field carries an id, because these dialogs are portaled out of the
// screen that opened them and a test has nothing else to find them by.
export const UserAdminDialogs = ({ controller }) => {
  const {
    currentUser,
    createOpen,
    setCreateOpen,
    newUser,
    setNewUser,
    creating,
    createUser,
    editingUser,
    setEditingUser,
    editForm,
    setEditForm,
    savingEdit,
    updateUser,
    deactivateTarget,
    setDeactivateTarget,
    deactivating,
    deactivateUser,
    resetCode,
    setResetCode,
  } = controller.state;

  return (
    <>
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create New User</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-admin-email">Email address</Label>
              <Input
                id="user-admin-email"
                type="email"
                placeholder="you@example.com"
                value={newUser.email}
                onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                What they sign in with. It cannot be changed later.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-admin-display-name">Display name (optional)</Label>
              <Input
                id="user-admin-display-name"
                placeholder="How they appear to everyone else"
                value={newUser.displayName}
                onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-admin-password">Password</Label>
              <Input
                id="user-admin-password"
                type="password"
                autoComplete="new-password"
                value={newUser.password}
                onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="user-admin-password-confirm">Confirm password</Label>
              <Input
                id="user-admin-password-confirm"
                type="password"
                autoComplete="new-password"
                value={newUser.confirmPassword}
                onChange={(e) => setNewUser({ ...newUser, confirmPassword: e.target.value })}
              />
            </div>
            <div className="flex items-start gap-2">
              <Switch
                id="new-admin"
                checked={newUser.isAdmin}
                onCheckedChange={(c) => setNewUser({ ...newUser, isAdmin: c })}
              />
              <div>
                <Label htmlFor="new-admin">Admin user</Label>
                <p className="text-xs text-muted-foreground">Grant this user admin privileges</p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={createUser} disabled={creating}>
              {creating ? 'Creating…' : 'Create User'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!editingUser}
        onOpenChange={(o) => {
          if (!o) setEditingUser(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingUser ? `Edit User: ${editingUser.displayName}` : ''}</DialogTitle>
          </DialogHeader>
          {editingUser && (
            <>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="user-admin-edit-email">Email address</Label>
                  <Input id="user-admin-edit-email" value={editingUser.id} disabled readOnly />
                  <p className="text-xs text-muted-foreground">
                    Fixed for the life of the account — it is what they sign in with.
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="user-admin-edit-display-name">Display name</Label>
                  <Input
                    id="user-admin-edit-display-name"
                    value={editForm.displayName}
                    onChange={(e) => setEditForm({ ...editForm, displayName: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="user-admin-edit-password">
                    New password (leave blank to keep current)
                  </Label>
                  <Input
                    id="user-admin-edit-password"
                    type="password"
                    autoComplete="new-password"
                    value={editForm.password}
                    onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="user-admin-edit-password-confirm">Confirm new password</Label>
                  <Input
                    id="user-admin-edit-password-confirm"
                    type="password"
                    autoComplete="new-password"
                    value={editForm.confirmPassword}
                    onChange={(e) => setEditForm({ ...editForm, confirmPassword: e.target.value })}
                  />
                </div>
                <div className="flex items-start gap-2">
                  <Switch
                    id="edit-admin"
                    checked={editForm.isAdmin}
                    onCheckedChange={(c) => setEditForm({ ...editForm, isAdmin: c })}
                  />
                  <Label htmlFor="edit-admin">Admin user</Label>
                </div>
              </div>
              <DialogFooter className="sm:justify-between">
                <Button
                  variant="destructive"
                  onClick={() => setDeactivateTarget(editingUser)}
                  disabled={editingUser.id === currentUser?.id || savingEdit}
                >
                  Deactivate
                </Button>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setEditingUser(null)}
                    disabled={savingEdit}
                  >
                    Cancel
                  </Button>
                  <Button onClick={updateUser} disabled={savingEdit}>
                    {savingEdit ? 'Saving…' : 'Update User'}
                  </Button>
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <MintedLinkDialog
        code={resetCode}
        onClose={() => setResetCode(null)}
        title="Password reset link created"
      />

      <AlertDialog
        open={!!deactivateTarget}
        onOpenChange={(o) => {
          if (!o) setDeactivateTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate user?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deactivateTarget?.displayName}</strong> ({deactivateTarget?.id}) will be
              signed out, lose every project role and API token, and be refused at login. Their
              annotations and their name on them are untouched. Reactivating restores login only.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deactivating}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                deactivateUser();
              }}
              disabled={deactivating}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deactivating ? 'Deactivating…' : 'Deactivate'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
