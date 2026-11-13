import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';

/**
 * Form state seeded from `initial`. While the person has not changed anything, a new `initial`
 * replaces the draft — e.g. their unit basis loads after the form opened, so a rate typed in ₹/kg
 * is shown as ₹/kg rather than the ₹/MT the first render assumed. Once edited, theirs wins.
 */
export function useDraft<T>(initial: T, same: (a: T, b: T) => boolean): [T, Dispatch<SetStateAction<T>>] {
  const [draft, setDraft] = useState(initial);
  const seeded = useRef(initial);
  useEffect(() => {
    if (initial === seeded.current) return;
    const untouched = same(draft, seeded.current);
    seeded.current = initial;
    if (untouched) setDraft(initial);
  }, [initial]);
  return [draft, setDraft];
}
