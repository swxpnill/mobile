import type { Draft } from '@tonnage/shared';
import type { drafts } from '../db/schema/index.ts';

export type DraftRow = typeof drafts.$inferSelect;

/** The row as `draftSchema`, with its creator's name (looked up by the caller). */
export function toDraft(d: DraftRow, creatorName: string): Draft {
  return {
    id: d.id,
    payload: d.payload,
    version: d.version,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    createdBy: { id: d.createdBy, name: creatorName },
  };
}
