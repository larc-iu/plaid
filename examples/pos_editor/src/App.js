import React, { useState } from 'react';
import LoginView from './components/LoginView';
import ProjectsView from './components/ProjectsView';
import DocumentsView from './components/DocumentsView';
import EditorView from './components/EditorView';

function App() {
  const [currentView, setCurrentView] = useState('login');
  const [client, setClient] = useState(null);
  const [currentProject, setCurrentProject] = useState(null);
  const [currentDocument, setCurrentDocument] = useState(null);

  const handleLogin = (plaidClient) => {
    setClient(plaidClient);
    setCurrentView('projects');
  };

  const handleProjectSelect = (project) => {
    setCurrentProject(project);
    setCurrentView('documents');
  };

  const handleDocumentSelect = (document) => {
    setCurrentDocument(document);
    setCurrentView('editor');
  };

  const handleBack = () => {
    if (currentView === 'editor') {
      setCurrentView('documents');
    } else if (currentView === 'documents') {
      setCurrentView('projects');
    } else if (currentView === 'projects') {
      setCurrentView('login');
      setClient(null);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="container mx-auto px-4 py-8">
        {currentView === 'login' && (
          <LoginView onLogin={handleLogin} />
        )}
        {currentView === 'projects' && client && (
          <ProjectsView 
            client={client} 
            onProjectSelect={handleProjectSelect}
            onBack={handleBack}
          />
        )}
        {currentView === 'documents' && client && currentProject && (
          <DocumentsView 
            client={client} 
            project={currentProject}
            onDocumentSelect={handleDocumentSelect}
            onBack={handleBack}
          />
        )}
        {currentView === 'editor' && client && currentProject && currentDocument && (
          <EditorView 
            client={client} 
            project={currentProject}
            document={currentDocument}
            onBack={handleBack}
          />
        )}
      </div>
    </div>
  );
}

export default App;