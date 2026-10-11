import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ALL_FLAGS_OFF } from '@/config/flags';
import { CommandDock, SLASH_COMMANDS } from './CommandDock';
import { FeatureFlagsProvider } from './feature-flags-context';
import { StopProvider } from './stop-context';
import { WorkspaceProvider } from './workspace-context';

function render(flags = ALL_FLAGS_OFF): string {
  return renderToStaticMarkup(
    createElement(
      WorkspaceProvider,
      null,
      createElement(StopProvider, {
        children: createElement(FeatureFlagsProvider, {
          flags,
          children: createElement(CommandDock),
        }),
      }),
    ),
  );
}

describe('command dock with optional features off', () => {
  const html = render();

  it('has no voice control, label or microphone text', () => {
    expect(html).not.toMatch(/voice|microphone|speech|listen/i);
  });

  it('keeps the core controls: input, Send, Stop, Activity and the command menu', () => {
    expect(html).toContain('Command or question for Aegis');
    expect(html).toContain('Send');
    expect(html).toContain('Stop');
    expect(html).toContain('Activity');
    expect(html).toContain('Commands');
  });

  it('lists no optional command and no coming-soon text', () => {
    expect(html).not.toMatch(/coming soon|not available yet/i);
    for (const command of SLASH_COMMANDS) {
      expect(command).not.toMatch(/voice|compare|brief|notes|reputation|identity/);
    }
  });

  it('reveals the voice control only when the server enabled the flag', () => {
    expect(render({ ...ALL_FLAGS_OFF, voice: true })).toContain('Voice unavailable');
  });
});
