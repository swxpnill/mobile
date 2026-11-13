import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { useDraftApi } from '../../api/hooks/orders';
import { useSubmitKey } from '../../api/submitKey';
import { type WizardState, fromPayload, toPayload } from './wizard';

export const AUTOSAVE_MS = 3_000;

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Server-side drafts for a new order (spec §5.3): the first change creates the draft (one
 * idempotency key, so a retry never makes two), later changes save 3 s after the last one with
 * the draft's version. If another phone saved the same draft meanwhile, the newer one is loaded.
 * Edit mode never autosaves — the order itself is the record.
 */
export function useDraftAutosave(opts: {
  state: WizardState | null;
  enabled: boolean;
  initialDraft: { id: string; version: number } | null;
  onReplaced(state: WizardState): void;
}): { draftId: string | null; status: SaveStatus; saveNow(): Promise<string | null>; forget(): Promise<void> } {
  const api = useDraftApi();
  const createKey = useSubmitKey();
  const draft = useRef<{ id: string; version: number } | null>(opts.initialDraft);
  const [draftId, setDraftId] = useState<string | null>(opts.initialDraft?.id ?? null);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const latest = useRef(opts.state);
  latest.current = opts.state;
  const saved = useRef<string>(opts.state ? JSON.stringify(toPayload(opts.state)) : '');
  const inFlight = useRef<Promise<string | null> | null>(null);
  const onReplaced = useRef(opts.onReplaced);
  onReplaced.current = opts.onReplaced;

  const save = useCallback(async (): Promise<string | null> => {
    const s = latest.current;
    if (!s) return draft.current?.id ?? null;
    const payload = toPayload(s);
    const text = JSON.stringify(payload);
    if (text === saved.current && draft.current) return draft.current.id;
    if (inFlight.current) await inFlight.current;
    const run = (async () => {
      setStatus('saving');
      try {
        if (!draft.current) {
          const d = await api.create(payload, createKey.key());
          createKey.settle();
          draft.current = { id: d.id, version: d.version };
          setDraftId(d.id);
        } else {
          const d = await api.save(draft.current.id, payload, draft.current.version);
          draft.current = { id: d.id, version: d.version };
        }
        saved.current = text;
        setStatus('saved');
        return draft.current.id;
      } catch (e) {
        createKey.settle(e);
        if (e instanceof ApiError && e.code === 'STALE' && draft.current) {
          // Saved on another phone meanwhile: theirs is newer, show it.
          try {
            const id = draft.current.id;
            const fresh = await api.load(id);
            draft.current = { id, version: fresh.version };
            const next = fromPayload(fresh.payload);
            if (next) {
              saved.current = JSON.stringify(toPayload(next));
              onReplaced.current(next);
            }
          } catch {
            /* keep ours; the next save tries again */
          }
        }
        setStatus('error');
        return draft.current?.id ?? null;
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = run;
    return run;
  }, [api, createKey]);

  const text = opts.state ? JSON.stringify(toPayload(opts.state)) : '';
  useEffect(() => {
    if (!opts.enabled || !opts.state || text === saved.current) return;
    const id = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(id);
  }, [text, opts.enabled]);

  return {
    draftId,
    status,
    saveNow: save,
    async forget() {
      const d = draft.current;
      draft.current = null;
      setDraftId(null);
      if (d) await api.remove(d.id).catch(() => undefined);
    },
  };
}
