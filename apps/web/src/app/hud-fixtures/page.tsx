import { notFound } from 'next/navigation';
import { HudFixtureStage } from '@/components/hud/HudFixtureStage';
import { isHudFixtureName } from '@/features/hud/public';

export const dynamic = 'force-dynamic';

/** Synthetic HUD scenes for tests and screenshots. Not found unless HUD_FIXTURES=1 at startup. */
export default async function HudFixturesPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  if (process.env.HUD_FIXTURES !== '1') notFound();
  const { state = 'idle' } = await searchParams;
  if (!isHudFixtureName(state)) notFound();
  return <HudFixtureStage name={state} />;
}
