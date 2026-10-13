/**
 * Approval stages during which the exact-action dialog owns focus. After signing the dialog is
 * gone: "signed" persists as a state, but it is not a ceremony and does not block commands.
 */
export const CEREMONY_STAGES: ReadonlySet<string> = new Set(['checking', 'preview', 'signing']);

export const isCeremonyStage = (stage: string): boolean => CEREMONY_STAGES.has(stage);
