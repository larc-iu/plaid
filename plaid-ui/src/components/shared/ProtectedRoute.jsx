import { Navigate, useLocation } from 'react-router-dom';
import { Loading } from './Loading.jsx';

// The guard every signed-in route sits behind, and what a reader sees while
// the session is still being worked out.
//
// The auth state is the app's, and a package file cannot reach an app's
// context, so the app binds its own hook once, at module scope in App.jsx:
//
//   const ProtectedRoute = createProtectedRoute(useAuth, { loginPath: '/login' });
//
// It cannot be a prop or a call inside App: App is what renders the
// AuthProvider, so there is no auth above it to read.
//
// `loginPath` is the app's too. A default here would be one app's routing
// table living in the package, which is how a shared screen ends up sending
// half its readers somewhere that is not theirs.
export const createProtectedRoute = (useAuth, { loginPath }) => {
  const ProtectedRoute = ({ children }) => {
    const { isAuthenticated, loading } = useAuth();
    const location = useLocation();

    if (loading) {
      return (
        <div className="min-h-screen bg-background">
          <Loading />
        </div>
      );
    }

    if (isAuthenticated) return children;
    // Sign-in goes on to where the reader was going.
    const from = location.pathname + location.search + location.hash;
    return <Navigate to={loginPath} replace state={{ from }} />;
  };
  return ProtectedRoute;
};
