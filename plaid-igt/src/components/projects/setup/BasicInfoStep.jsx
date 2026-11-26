import { t } from '@ui/lib/i18n.js';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { isEnter } from '@ui/lib/chords.js';

export const BasicInfoStep = ({ data, onDataChange, onNext }) => {
  const handleProjectNameChange = (event) => {
    onDataChange({
      ...data,
      projectName: event.currentTarget.value,
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="project-name">
          {t('Project name')} <span className="text-destructive">*</span>
        </Label>
        {/* The one field of the first step: it takes the caret, and Enter goes
            on to the next step, as Next does. */}
        <Input
          id="project-name"
          autoFocus
          placeholder={t('Enter a name for your project')}
          value={data?.projectName || ''}
          onChange={handleProjectNameChange}
          onKeyDown={(e) => {
            if (!isEnter(e)) return;
            e.preventDefault();
            onNext?.();
          }}
        />
      </div>
    </div>
  );
};

// Validation function for this step
BasicInfoStep.isValid = (data) => {
  const projectName = data?.projectName || '';
  return projectName.trim().length > 0;
};
