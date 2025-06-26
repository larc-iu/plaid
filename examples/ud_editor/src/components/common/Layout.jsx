import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

export const Layout = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  // Check if we're on the annotation editor route
  const isAnnotationEditor = location.pathname.includes('/annotate');

  return (
    <div className="flex flex-col min-h-screen">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <h1 className="text-xl font-semibold text-gray-900">UD Editor</h1>
            {user && (
              <div className="flex items-center gap-4">
                <Link 
                  to="/profile"
                  className="text-sm text-gray-600 hover:text-gray-900 px-3 py-1.5 rounded-md hover:bg-gray-100 transition-colors"
                >
                  👤 {user.username}
                </Link>
                <button 
                  onClick={handleLogout} 
                  className="text-sm text-gray-700 hover:text-gray-900 px-3 py-1.5 rounded-md hover:bg-gray-100 transition-colors"
                >
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <main className={isAnnotationEditor ? "flex-1" : "flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8"}>
        <Outlet />
      </main>
    </div>
  );
};