import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ALL_FLAGS_OFF } from '@/config/flags';
import { FeatureFlagsProvider } from '@/components/shell/feature-flags-context';
import { ReviewChecklist, ReviewEvidence } from './DocumentWorkspace';

const render = (comparison: boolean) =>
  renderToStaticMarkup(
    createElement(FeatureFlagsProvider, {
      flags: { ...ALL_FLAGS_OFF, documentComparison: comparison },
      children: createElement(ReviewEvidence),
    }),
  );

describe('left-rail evidence checklist', () => {
  it('is its own region, so the attention rail carries no checklist', () => {
    expect(renderToStaticMarkup(createElement(ReviewChecklist))).toContain('Evidence checklist');
    expect(render(false)).not.toContain('Evidence checklist');
  });
});

describe('review evidence column', () => {
  it('has no comparison heading, control or empty panel while the flag is off', () => {
    const html = render(false);
    expect(html).not.toMatch(/Compare versions|Old version|Document comparison/);
  });

  it('shows the comparison only when the flag is on', () => {
    expect(render(true)).toContain('Compare versions');
  });

  it('always labels the what-if as SIMULATED', () => {
    for (const on of [false, true]) {
      const html = render(on);
      expect(html).toContain('SIMULATED');
      expect(html).not.toMatch(/Apply to agreement|Correct the agreement/i);
    }
  });
});
