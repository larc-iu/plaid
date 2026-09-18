import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { lazyNamed } from '@ui/lib/lazyNamed.js';
import { Suspended } from '@ui/components/shared/Suspended.jsx';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { Layout } from './components/Layout';
import { createProtectedRoute } from '@ui/components/shared/ProtectedRoute.jsx';
import { LoginForm } from '@ui/components/auth/LoginForm.jsx';
import { RedeemInvite } from '@ui/components/auth/RedeemInvite.jsx';
import { UserProfile } from '@ui/components/auth/UserProfile.jsx';
import { ProjectList } from './components/projects/ProjectList';
import { DocumentList } from './components/documents/DocumentList';
import { AnnotationEditor } from './components/editor/AnnotationEditor.jsx';
import { DocumentEditorShell } from './components/editor/DocumentEditorShell.jsx';
import { DocumentDetails } from './components/documents/DocumentDetails.jsx';
import './App.css';

// Screens a session opens rarely download when first opened. The editor and
// the two lists stay eager, being where a session starts and spends its time.
const ProjectImportExport = lazyNamed(
  () => import('./components/projects/ProjectImportExport.jsx'),
  'ProjectImportExport',
);
const ProjectSettings = lazyNamed(
  () => import('./components/projects/ProjectSettings.jsx'),
  'ProjectSettings',
);
const ProjectGuidelinesPage = lazyNamed(
  () => import('./components/projects/ProjectGuidelinesPage.jsx'),
  'ProjectGuidelinesPage',
);
const ProjectActivity = lazyNamed(
  () => import('./components/projects/ProjectActivity.jsx'),
  'ProjectActivity',
);
const ProjectValidation = lazyNamed(
  () => import('./components/validate/ProjectValidation.jsx'),
  'ProjectValidation',
);
const DocumentComments = lazyNamed(
  () => import('./components/documents/DocumentComments.jsx'),
  'DocumentComments',
);
const ProjectConfiguration = lazyNamed(
  () => import('./components/projects/ProjectConfiguration.jsx'),
  'ProjectConfiguration',
);
const ExportEditor = lazyNamed(
  () => import('./components/editor/ExportEditor.jsx'),
  'ExportEditor',
);

// Bound at module scope: App renders the AuthProvider, so there is no auth
// state above it to read.
const ProtectedRoute = createProtectedRoute(useAuth, { loginPath: '/login' });

const settingsPaths = ['management', 'customization', 'services', 'tokens', 'general'];

function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <Routes>
          <Route
            path="/login"
            element={
              <LoginForm tagline="Uniform Meaning Representation Editor" homePath="/projects" />
            }
          />
          {/* Unauthenticated by necessity: whoever follows an invite link has
              no account yet. The code rides in the hash fragment, so it never
              reaches the server as part of a URL. */}
          <Route
            path="/invite/:code"
            element={<RedeemInvite loginPath="/login" homePath="/projects" />}
          />

          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="/projects" replace />} />
            <Route path="profile" element={<UserProfile />} />
            <Route path="projects" element={<ProjectList />} />
            <Route path="projects/:projectId/documents" element={<DocumentList />} />
            <Route
              path="projects/:projectId/validate"
              element={
                <Suspended>
                  <ProjectValidation />
                </Suspended>
              }
            />
            <Route
              path="projects/:projectId/guidelines"
              element={
                <Suspended>
                  <ProjectGuidelinesPage />
                </Suspended>
              }
            />
            <Route
              path="projects/:projectId/activity"
              element={
                <Suspended>
                  <ProjectActivity />
                </Suspended>
              }
            />
            <Route
              path="projects/:projectId/import-export"
              element={
                <Suspended>
                  <ProjectImportExport />
                </Suspended>
              }
            />
            {/* Project settings, tabbed. Every path renders the same view and
                the active tab follows the path. */}
            {settingsPaths.map((p) => (
              <Route
                key={p}
                path={`projects/:projectId/${p}`}
                element={
                  <Suspended>
                    <ProjectSettings />
                  </Suspended>
                }
              />
            ))}
            {/* Layer setup for a project another app made, and the destination
                of the document list's missing-layers redirect. */}
            <Route
              path="projects/:projectId/configuration"
              element={
                <Suspended>
                  <ProjectConfiguration />
                </Suspended>
              }
            />

            {/* The document tabs are CHILDREN of one shell route, so the shell
                stays mounted across tab switches and the document loads once. */}
            <Route
              path="projects/:projectId/documents/:documentId"
              element={<DocumentEditorShell />}
            >
              <Route path="annotate" element={<AnnotationEditor />} />
              <Route path="details" element={<DocumentDetails />} />
              <Route
                path="comments"
                element={
                  <Suspended>
                    <DocumentComments />
                  </Suspended>
                }
              />
              <Route
                path="export"
                element={
                  <Suspended>
                    <ExportEditor />
                  </Suspended>
                }
              />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </AuthProvider>
    </HashRouter>
  );
}

export default App;
