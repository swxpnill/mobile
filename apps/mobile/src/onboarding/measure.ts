import type { ComponentRef } from 'react';
import type { View } from 'react-native';

/** `measureInWindow` behind a seam, so tests can place targets without a native layout. */
export function measure(
  node: ComponentRef<typeof View> | null,
  cb: (x: number, y: number, w: number, h: number) => void,
): void {
  node?.measureInWindow?.(cb);
}
