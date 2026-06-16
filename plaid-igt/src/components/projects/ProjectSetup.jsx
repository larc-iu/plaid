import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Info, Layers, FileText, Languages, List, BookOpen, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Step components
import { BasicInfoStep } from './setup/BasicInfoStep';
import { LayerSelectionStep } from './setup/LayerSelectionStep';
import { DocumentMetadataStep } from './setup/DocumentMetadataStep';
import { OrthographiesStep } from './setup/OrthographiesStep';
import { FieldsStep } from './setup/FieldsStep';
import { VocabularyStep } from './setup/VocabularyStep';
import { ConfirmationStep } from './setup/ConfirmationStep';

export const ProjectSetup = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user, client } = useAuth();

  const [currentStep, setCurrentStep] = useState(0);
  const [setupData, setSetupData] = useState({
    // Will accumulate all setup configuration here
    basicInfo: {},
    layerSelection: {},
    documentMetadata: {},
    orthographies: {},
    fields: {},
    vocabulary: {},
  });

  // Helper function to convert step ID to camelCase data key
  const stepIdToDataKey = (stepId) => {
    // Convert kebab-case to camelCase
    return stepId.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
  };

  // For /projects/new, projectId will be undefined
  // For /projects/:projectId/setup, projectId will be the actual ID
  const isNewProject = !projectId || projectId === 'new';

  const steps = [
    ...(isNewProject ? [{
      id: 'basic-info',
      title: 'Basic Information',
      icon: Info,
      component: BasicInfoStep
    }] : []),
    ...(!isNewProject ? [{
      id: 'layer-selection',
      title: 'Layer Selection',
      icon: Layers,
      component: LayerSelectionStep
    }] : []),
    {
      id: 'document-metadata',
      title: 'Document Metadata',
      icon: FileText,
      component: DocumentMetadataStep
    },
    {
      id: 'orthographies',
      title: 'Orthographies',
      icon: Languages,
      component: OrthographiesStep
    },
    {
      id: 'fields',
      title: 'Fields',
      icon: List,
      component: FieldsStep
    },
    {
      id: 'vocabulary',
      title: 'Vocabulary',
      icon: BookOpen,
      component: VocabularyStep
    },
    {
      id: 'confirmation',
      title: 'Confirmation',
      icon: Check,
      component: ConfirmationStep
    }
  ];

  const currentStepData = steps[currentStep];
  const StepComponent = currentStepData.component;

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    }
  };

  const handlePrevious = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleStepClick = (stepIndex) => {
    setCurrentStep(stepIndex);
  };

  const updateSetupData = (stepKey, data) => {
    setSetupData(prev => ({
      ...prev,
      [stepKey]: data
    }));
  };

  // Check if current step is valid for progression
  const isCurrentStepValid = () => {
    const currentStepData = steps[currentStep];
    const StepComponent = currentStepData.component;
    const stepKey = stepIdToDataKey(currentStepData.id);
    const stepData = setupData[stepKey];

    // If the step component has a validation function, use it
    if (StepComponent.isValid) {
      return StepComponent.isValid(stepData);
    }

    // Default to valid if no validation function
    return true;
  };

  return (
    <div className="tw mx-auto max-w-7xl px-4 py-8">
      <div className="flex flex-col gap-8">
        <nav className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/projects" className="hover:text-foreground hover:underline">Projects</Link>
          <span>/</span>
          {isNewProject ? (
            <>
              <Link to="/projects/new" className="hover:text-foreground hover:underline">New Project</Link>
              <span>/</span>
              <span>Start from scratch</span>
            </>
          ) : (
            <span>Project Setup</span>
          )}
        </nav>

        <div>
          <h1 className="text-2xl font-bold">
            {isNewProject ? 'Create New Project' : 'Project Setup'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isNewProject
              ? 'Set up a new Plaid IGT project.'
              : 'Configure your existing project for annotation with Plaid IGT.'
            }
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-12">
          <div className="md:col-span-3">
            <div className="rounded-lg border bg-card p-4">
              <ol className="flex flex-col gap-3">
                {steps.map((step, index) => (
                  <li key={step.id} className="flex items-center gap-2 text-sm">
                    <span
                      className={cn(
                        'flex h-6 w-6 items-center justify-center rounded-full border text-xs',
                        index <= currentStep
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-muted text-muted-foreground'
                      )}
                    >
                      <step.icon className="h-3.5 w-3.5" />
                    </span>
                    <span className={cn(index === currentStep && 'font-medium')}>{step.title}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          <div className="md:col-span-9">
            <div className="rounded-lg border bg-card p-6">
              <div className="flex flex-col gap-6">
                <div>
                  <h2 className="text-lg font-semibold">{currentStepData.title}</h2>
                </div>

                <StepComponent
                  data={setupData[stepIdToDataKey(currentStepData.id)]}
                  onDataChange={(data) => updateSetupData(stepIdToDataKey(currentStepData.id), data)}
                  setupData={setupData}
                  isNewProject={isNewProject}
                  projectId={projectId}
                  user={user}
                  client={client}
                />

                <div className="flex items-center justify-between gap-2 pt-4">
                  <Button
                    variant="outline"
                    onClick={handlePrevious}
                    disabled={currentStep === 0}
                  >
                    Previous
                  </Button>

                  <Button
                    onClick={handleNext}
                    disabled={currentStep === steps.length - 1 || !isCurrentStepValid()}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
