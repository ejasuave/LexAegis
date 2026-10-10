/*
 * Named GraphQL operations for the Envio history service. Hasura-style root fields over the
 * entities in indexer/schema.graphql. The same text lives in indexer/queries/*.graphql and a test
 * keeps them identical. Variables only: no caller-supplied query text ever reaches the service.
 */
const STATE_FIELDS = `id chainId genesisHash registryAddress configFingerprint generation projectionVersion startBlock rawEventCount actionCount pendingSupersessions lastEventId lastEventBlockNumber lastEventBlockHash lastEventLogIndex`;
const ACTION_FIELDS = `id reviewer kind consumedNonce nextNonce commitment relatedCommitment transactionHash executor blockNumber blockHash timestamp firstEventId lastEventId firstLogIndex lastLogIndex eventCount`;
const RECEIPT_FIELDS = `id reviewer commitment status predecessor successor issuedAt updatedAt issuingActionId latestActionId`;

export const OPERATIONS = {
  HistoryMeta: `query HistoryMeta {
  _meta { chainId startBlock progressBlock sourceBlock isReady eventsProcessed }
  RegistryState(limit: 2) { ${STATE_FIELDS} }
}`,
  ReviewerSummary: `query ReviewerSummary($id: String!) {
  ReviewerSummary_by_pk(id: $id) { id reviewer nextNonce totalReceipts activeReceipts revokedReceipts supersededReceipts actionCount }
}`,
  ReviewerActions: `query ReviewerActions($reviewer: String!, $upper: numeric!, $limit: Int!) {
  IndexedAction(
    where: { reviewer: { _eq: $reviewer }, consumedNonce: { _lte: $upper } }
    order_by: { consumedNonce: desc }
    limit: $limit
  ) { ${ACTION_FIELDS} }
}`,
  ActionAnchors: `query ActionAnchors($ids: [String!]!) {
  IndexedAction(where: { id: { _in: $ids } }, limit: 2) { ${ACTION_FIELDS} }
}`,
  ReceiptDetail: `query ReceiptDetail($id: String!) {
  IndexedReceipt_by_pk(id: $id) { ${RECEIPT_FIELDS} }
}`,
  ReceiptLink: `query ReceiptLink($id: String!) {
  IndexedReceipt_by_pk(id: $id) { ${RECEIPT_FIELDS} }
}`,
} as const;
export type OperationName = keyof typeof OPERATIONS;
