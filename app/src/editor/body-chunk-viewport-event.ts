export const BODY_CHUNK_VIEWPORT_CHANGED_EVENT =
  "memoka:body-chunk-viewport-changed";

export interface BodyChunkViewportChangedDetail {
  readonly activeChunkIds: readonly string[];
  readonly changedChunkIds: readonly string[];
}
