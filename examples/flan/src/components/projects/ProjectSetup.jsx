import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { 
  Container, 
  Title, 
  Text, 
  Stack,
  Paper,
  Group,
  Button,
  Timeline,
  Grid,
  Breadcrumbs,
  Anchor
} from '@mantine/core';
import { 
  IconInfoCircle, 
  IconStack, 
  IconFileText, 
  IconLanguage, 
  IconList, 
  IconBook2, 
  IconCheck 
} from '@tabler/icons-react';

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
  const { user, getClient } = useAuth();
  
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
      icon: IconInfoCircle,
      component: BasicInfoStep
    }] : []),
    ...(!isNewProject ? [{
      id: 'layer-selection',
      title: 'Layer Selection',
      icon: IconStack,
      component: LayerSelectionStep
    }] : []),
    {
      id: 'document-metadata',
      title: 'Document Metadata',
      icon: IconFileText,
      component: DocumentMetadataStep
    },
    {
      id: 'orthographies',
      title: 'Orthographies',
      icon: IconLanguage,
      component: OrthographiesStep
    },
    {
      id: 'fields',
      title: 'Fields',
      icon: IconList,
      component: FieldsStep
    },
    {
      id: 'vocabulary',
      title: 'Vocabulary',
      icon: IconBook2,
      component: VocabularyStep
    },
    {
      id: 'confirmation',
      title: 'Confirmation',
      icon: IconCheck,
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

  const breadcrumbItems = [
    { title: 'Projects', href: '/projects' },
    { title: isNewProject ? 'New Project' : 'Project Setup', href: null }
  ].map((item, index) => (
    item.href ? (
      <Anchor key={index} component={Link} to={item.href}>
        {item.title}
      </Anchor>
    ) : (
      <Text key={index}>{item.title}</Text>
    )
  ));

  return (
    <Container size="xl" py="xl">
      <Stack spacing="xl">
        <Breadcrumbs>
          {breadcrumbItems}
        </Breadcrumbs>

        <div>
          <Title order={1}>
            {isNewProject ? 'Create New Project' : 'Project Setup'}
          </Title>
          <Text c="dimmed" size="sm">
            {isNewProject
              ? 'Set up a new Flan project.'
              : 'Configure your existing project for annotation with Flan.'
            }
          </Text>
        </div>

        <Grid>
          <Grid.Col span={3}>
            <Paper p="md" withBorder>
              <Timeline active={currentStep} bulletSize={24} lineWidth={2}>
                {steps.map((step, index) => (
                  <Timeline.Item
                    key={step.id}
                    bullet={<step.icon size={14} />}
                    title={step.title}
                  >
                  </Timeline.Item>
                ))}
              </Timeline>
            </Paper>
          </Grid.Col>

          <Grid.Col span={9}>
            <Paper p="xl" withBorder>
              <Stack spacing="lg">
                <div>
                  <Title order={2}>{currentStepData.title}</Title>
                </div>

                <StepComponent
                  data={setupData[stepIdToDataKey(currentStepData.id)]}
                  onDataChange={(data) => updateSetupData(stepIdToDataKey(currentStepData.id), data)}
                  setupData={setupData}
                  isNewProject={isNewProject}
                  projectId={projectId}
                  user={user}
                  getClient={getClient}
                />

                <Group justify="space-between" pt="md">
                  <Button
                    variant="default"
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
                </Group>
              </Stack>
            </Paper>
          </Grid.Col>
        </Grid>
      </Stack>
    </Container>
  );
};