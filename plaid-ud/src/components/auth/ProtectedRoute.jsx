import { Navigate } from 'react-router-dom';
import { Center, Loader } from '@mantine/core';
import { useAuth } from '../../contexts/AuthContext';

export const ProtectedRoute = ({ children }) => {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return <Center mih="100vh"><Loader /></Center>;
  }

  return isAuthenticated ? children : <Navigate to="/login" replace />;
};
