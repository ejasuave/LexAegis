'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { ALL_FLAGS_OFF, type EffectiveFlags, type ProductFlag } from '@/config/flags';

const FeatureFlagsContext = createContext<EffectiveFlags>(ALL_FLAGS_OFF);

/** Receives the server's validated effective flags. Nothing on the client can change them. */
export function FeatureFlagsProvider({
  flags,
  children,
}: {
  flags: EffectiveFlags;
  children: ReactNode;
}) {
  return <FeatureFlagsContext.Provider value={flags}>{children}</FeatureFlagsContext.Provider>;
}

export function useFeatureFlag(flag: ProductFlag): boolean {
  return useContext(FeatureFlagsContext)[flag];
}
