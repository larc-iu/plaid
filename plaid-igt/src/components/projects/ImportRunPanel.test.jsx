import { describe, it, expect, vi } from 'vitest';
import { renderComponent, byText, texts } from '@ui/test/renderComponent.jsx';
import { ImportRunPanel, ProjectNameField, ResumeBanner } from './ImportPanels.jsx';

// The four project-import wizards read four different files and share this.
// Each used to draw its own, and they drifted: one clamped the progress bar
// and three did not, so a run whose phase reported past its share of the bar
// drew a fill wider than the track.

const width = (container) => container.querySelector('.bg-primary')?.style.width;

describe('ImportRunPanel', () => {
  it('draws the bar and the step while a run goes', async () => {
    const { container, unmount } = await renderComponent(
      <ImportRunPanel stage="running" progress={{ label: 'Creating words', pct: 42.6 }} />,
    );
    expect(width(container)).toBe('43%');
    expect(byText(container, 'p', 'Creating words')).not.toBeNull();
    await unmount();
  });

  it('never draws a fill wider than the track, or narrower than nothing', async () => {
    for (const [pct, expected] of [
      [140, '100%'],
      [-5, '0%'],
      [undefined, '0%'],
    ]) {
      const { container, unmount } = await renderComponent(
        <ImportRunPanel stage="running" progress={{ label: 'x', pct }} />,
      );
      expect(width(container)).toBe(expected);
      await unmount();
    }
  });

  it('says a run is starting before a phase has reported', async () => {
    const { container, unmount } = await renderComponent(
      <ImportRunPanel stage="running" progress={null} />,
    );
    expect(byText(container, 'p', 'Starting…')).not.toBeNull();
    await unmount();
  });

  it('offers Stop only while the run goes', async () => {
    const onStop = vi.fn();
    const { container, step, unmount } = await renderComponent(
      <ImportRunPanel stage="running" progress={{ label: 'x', pct: 1 }} onStop={onStop} />,
    );
    await step(() => byText(container, 'button', 'Stop').click());
    expect(onStop).toHaveBeenCalled();
    await unmount();

    const done = await renderComponent(<ImportRunPanel stage="review" onStop={onStop} />);
    expect(byText(done.container, 'button', 'Stop')).toBeNull();
    await done.unmount();
  });

  it('reports a failure with what failed, and a stop as a stop', async () => {
    const failed = await renderComponent(
      <ImportRunPanel stage="review" runError="The server said 500" />,
    );
    expect(byText(failed.container, 'p', 'Import failed')).not.toBeNull();
    expect(texts(failed.container, 'p')).toContain('The server said 500');
    expect(texts(failed.container, 'p')).toContain('Retry continues where it left off.');
    await failed.unmount();

    const stopped = await renderComponent(
      <ImportRunPanel stage="review" runError="Import cancelled" stopped />,
    );
    expect(byText(stopped.container, 'p', 'Import stopped')).not.toBeNull();
    expect(texts(stopped.container, 'p')).not.toContain('Import cancelled');
    await stopped.unmount();
  });

  // Which of the two it was is the run's to say. Deciding it from the error's
  // wording titled a failure whose message happened to carry the word
  // "cancel" -- a server's, or a future client's -- as something the person
  // had asked for, and suppressed the only account of it.
  it('reports a failure that says "cancelled" as a failure, and says what it was', async () => {
    const { container, unmount } = await renderComponent(
      <ImportRunPanel
        stage="review"
        runError="The server could not cancel the pending write: 503"
        stopped={false}
      />,
    );
    expect(byText(container, 'p', 'Import failed')).not.toBeNull();
    expect(texts(container, 'p')).toContain('The server could not cancel the pending write: 503');
    await unmount();
  });

  it('keeps the error off the screen while the run is going again', async () => {
    const { container, unmount } = await renderComponent(
      <ImportRunPanel stage="running" runError="The server said 500" progress={{ pct: 3 }} />,
    );
    expect(byText(container, 'p', 'Import failed')).toBeNull();
    await unmount();
  });
});

describe('ProjectNameField', () => {
  it('names the box so the label reaches it', async () => {
    const { container, unmount } = await renderComponent(
      <ProjectNameField id="x-project-name" value="Qusar" onChange={() => {}} />,
    );
    const label = byText(container, 'label', 'Project name');
    expect(label.getAttribute('for')).toBe('x-project-name');
    expect(container.querySelector('#x-project-name').value).toBe('Qusar');
    await unmount();
  });

  it('says the project is one being continued only on a resume', async () => {
    const plain = await renderComponent(
      <ProjectNameField id="a" value="" onChange={() => {}} resuming={false} />,
    );
    expect(byText(plain.container, 'p', 'Continuing an import into this project')).toBeNull();
    await plain.unmount();

    const resuming = await renderComponent(
      <ProjectNameField id="a" value="" onChange={() => {}} resuming />,
    );
    expect(
      byText(resuming.container, 'p', 'Continuing an import into this project'),
    ).not.toBeNull();
    await resuming.unmount();
  });
});

describe('ResumeBanner', () => {
  it('names the project and offers to finish as it is', async () => {
    const onFinishAsIs = vi.fn();
    const { container, step, unmount } = await renderComponent(
      <ResumeBanner
        name="Qusar"
        again="Choose the same file: what is already there is kept."
        onFinishAsIs={onFinishAsIs}
      />,
    );
    expect(container.textContent).toContain('Qusar');
    expect(container.textContent).toContain('Choose the same file');
    await step(() => byText(container, 'button', 'Use the project as it is').click());
    expect(onFinishAsIs).toHaveBeenCalled();
    await unmount();
  });

  it('falls back to naming it as this project when the record has no name', async () => {
    const { container, unmount } = await renderComponent(
      <ResumeBanner name={null} again="Choose the same file." onFinishAsIs={() => {}} />,
    );
    expect(container.textContent).toContain('this project');
    await unmount();
  });
});
