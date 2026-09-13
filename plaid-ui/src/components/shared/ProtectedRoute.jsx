import { Navigate } from 'react-router-dom';

// The guard every signed-in route sits behind, and what a reader sees while
// the session is still being worked out.
//
// The auth state is the app's, and a package file cannot reach an app's
// context, so the app binds its own hook once, at module scope in App.jsx:
//
//   const ProtectedRoute = createProtectedRoute(useAuth);
//
// It cannot be a prop or a call inside App: App is what renders the
// AuthProvider, so there is no auth above it to read.
export const createProtectedRoute = (useAuth) => {
  const ProtectedRoute = ({ children, loginPath = '/login' }) => {
    const { isAuthenticated, loading } = useAuth();

    if (loading) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
        </div>
      );
    }

    return isAuthenticated ? children : <Navigate to={loginPath} replace />;
  };
  return ProtectedRoute;
};
