import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Info, Layers, FileText, Languages, List, BookOpen, Check } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { cn } from '@ui/lib/utils';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { Breadcrumb } from '@ui/components/shared/Breadcrumb.jsx';

// Step components
import { BasicInfoStep } from './setup/BasicInfoStep';
import { LayerSelectionStep } from './setup/LayerSelectionStep';
import { DocumentMetadataStep } from './setup/DocumentMetadataStep';
import { OrthographiesStep } from './setup/OrthographiesStep';
import { FieldsStep } from './setup/FieldsStep';
import { VocabularyStep } from './setup/VocabularyStep';
import { ConfirmationStep } from './setup/ConfirmationStep';
import { FORM_PAGE_WIDTH } from '@ui/lib/pageWidth.js';

export const ProjectSetup = () => {
  useDocumentTitle('Project setup');
  const { projectId } = useParams();
  const { client } = useAuth();

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
    ...(isNewProject
      ? [
          {
            id: 'basic-info',
            title: 'Basic information',
            icon: Info,
            component: BasicInfoStep,
          },
        ]
      : []),
    ...(!isNewProject
      ? [
          {
            id: 'layer-selection',
            title: 'Text layer',
            icon: Layers,
            component: LayerSelectionStep,
          },
        ]
      : []),
    {
      id: 'document-metadata',
      title: 'Document metadata',
      icon: FileText,
      component: DocumentMetadataStep,
    },
    {
      id: 'orthographies',
      title: 'Orthographies',
      icon: Languages,
      component: OrthographiesStep,
    },
    {
      id: 'fields',
      title: 'Fields',
      icon: List,
      component: FieldsStep,
    },
    {
      id: 'vocabulary',
      title: 'Vocabulary',
      icon: BookOpen,
      component: VocabularyStep,
    },
    {
      id: 'confirmation',
      title: 'Confirmation',
      icon: Check,
      component: ConfirmationStep,
    },
  ];

  // A new step puts focus on its heading, where reading it starts. Next,
  // Previous and Enter in a field all change the step, and the button that was
  // pressed may be gone (the last step has no Next).
  const stepHeading = useRef(null);
  const stepBody = useRef(null);
  const shownStep = useRef(currentStep);
  useEffect(() => {
    if (shownStep.current === currentStep) return;
    shownStep.current = currentStep;
    // A step that puts the caret in its own field (Basic information) keeps it.
    if (stepBody.current?.contains(document.activeElement)) return;
    stepHeading.current?.focus({ preventScroll: true });
  }, [currentStep]);

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
    setSetupData((prev) => ({
      ...prev,
      [stepKey]: data,
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
    <div className={FORM_PAGE_WIDTH}>
      <div className="flex flex-col gap-8">
        <Breadcrumb
          items={
            isNewProject
              ? [
                  { label: 'Projects', to: '/projects', fixed: true },
                  { label: 'New project', to: '/projects/new', fixed: true },
                ]
              : [{ label: 'Projects', to: '/projects', fixed: true }]
          }
        />

        <div>
          <h1 className="text-2xl font-bold">
            {isNewProject ? 'Start from scratch' : 'Project setup'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isNewProject
              ? 'Set up a new Plaid IGT project.'
              : 'Set this project up for Plaid IGT.'}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-12">
          <div className="md:col-span-3">
            <div className="rounded-lg border bg-card p-4">
              <ol className="flex flex-col gap-3">
                {steps.map((step, index) => {
                  // Completed steps are real links back (revisit + edit); the
                  // current and future steps are inert labels (forward
                  // navigation goes through Next so validation runs).
                  const done = index < currentStep;
                  return (
                    <li key={step.id} className="flex items-center gap-2 text-sm">
                      <button
                        type="button"
                        disabled={!done}
                        onClick={() => handleStepClick(index)}
                        className={cn(
                          'flex items-center gap-2 text-left',
                          done ? 'cursor-pointer hover:underline' : 'cursor-default',
                        )}
                        aria-current={index === currentStep ? 'step' : undefined}
                      >
                        <span
                          className={cn(
                            'flex h-6 w-6 items-center justify-center rounded-full border text-xs',
                            index <= currentStep
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-muted text-muted-foreground',
                          )}
                        >
                          <step.icon className="h-3.5 w-3.5" />
                        </span>
                        <span className={cn(index === currentStep && 'font-medium')}>
                          {step.title}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>

          <div className="md:col-span-9">
            <div className="rounded-lg border bg-card p-6">
              <div className="flex flex-col gap-6">
                <div>
                  <h2
                    ref={stepHeading}
                    tabIndex={-1}
                    className="text-lg font-semibold focus:outline-none"
                  >
                    {currentStepData.title}
                  </h2>
                </div>

                <div ref={stepBody}>
                  <StepComponent
                    data={setupData[stepIdToDataKey(currentStepData.id)]}
                    onDataChange={(data) =>
                      updateSetupData(stepIdToDataKey(currentStepData.id), data)
                    }
                    setupData={setupData}
                    onNext={() => {
                      if (currentStep < steps.length - 1 && isCurrentStepValid()) handleNext();
                    }}
                    isNewProject={isNewProject}
                    projectId={projectId}
                    client={client}
                  />
                </div>

                <div className="flex items-center justify-between gap-2 pt-4">
                  <Button variant="outline" onClick={handlePrevious} disabled={currentStep === 0}>
                    Previous
                  </Button>

                  {/* No Next on the last step. It used to render there,
                    permanently greyed, in the bottom-right corner five steps
                    had trained the eye on, while the real commit button sat in
                    its own row above the footer. The first read of that is
                    that the wizard is stuck. */}
                  {currentStep < steps.length - 1 && (
                    <Button onClick={handleNext} disabled={!isCurrentStepValid()}>
                      Next
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
