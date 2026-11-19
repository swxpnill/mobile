// F5 Task 10: a TalkBack-minded audit of a rendered screen (F5 Ruling 14).
import { StyleSheet } from 'react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';

export interface A11yIssue {
  rule: 'name' | 'role' | 'target' | 'header';
  path: string;
  detail: string;
}

const MIN_TOUCH = 44;
type Node = ReactTestRendererJSON;
type Props = Record<string, unknown>;

/** Text a screen reader would read inside `n` when it has no label of its own. */
function textOf(n: Node | string): string {
  if (typeof n === 'string') return n;
  const label = (n.props as Props).accessibilityLabel;
  if (typeof label === 'string') return label;
  return (n.children ?? []).map(textOf).join(' ').trim();
}

const slop = (h: unknown, side: 'top' | 'bottom' | 'left' | 'right'): number =>
  typeof h === 'number' ? h : h && typeof h === 'object' ? Number((h as Record<string, number>)[side] ?? 0) : 0;

/** The touch box along one axis: explicit size (or min size) plus hit slop; undefined when the layout decides. */
function reach(style: Props | undefined, hit: unknown, axis: 'width' | 'height'): number | undefined {
  // 0 is a flex layout trick (`minWidth: 0` lets text shrink), not a size.
  const size = [style?.[axis], style?.[axis === 'width' ? 'minWidth' : 'minHeight']].filter((v): v is number => typeof v === 'number' && v > 0);
  if (size.length === 0) return undefined;
  const pad = axis === 'width' ? slop(hit, 'left') + slop(hit, 'right') : slop(hit, 'top') + slop(hit, 'bottom');
  return Math.max(...size) + pad;
}

/**
 * Every pressable has a role and a spoken name, and a touch box of at least 44 dp where the
 * style fixes its size; the screen has a header. Nodes hidden from accessibility (inside an
 * `accessibilityElementsHidden` / `importantForAccessibility="no-hide-descendants"` branch) are skipped.
 */
export function auditA11y(root: Node | Node[] | null, opts: { header?: boolean } = {}): A11yIssue[] {
  const issues: A11yIssue[] = [];
  let headers = 0;
  const walk = (n: Node, path: string) => {
    const p = n.props as Props;
    if (p.accessibilityElementsHidden === true || p.importantForAccessibility === 'no-hide-descendants') return;
    const here = `${path}/${String(n.type)}${typeof p.testID === 'string' ? `#${p.testID}` : ''}`;
    if (p.accessibilityRole === 'header') headers += 1;
    if (typeof p.onClick === 'function' && p.accessible !== false) {
      const name = textOf(n);
      if (!p.accessibilityRole) issues.push({ rule: 'role', path: here, detail: name || '(unnamed)' });
      if (!name) issues.push({ rule: 'name', path: here, detail: 'pressable with nothing to read' });
      const style = StyleSheet.flatten(p.style as never) as Props | undefined;
      for (const axis of ['width', 'height'] as const) {
        const r = reach(style, p.hitSlop, axis);
        if (r !== undefined && r < MIN_TOUCH) issues.push({ rule: 'target', path: here, detail: `${name || '(unnamed)'}: ${axis} ${r} < ${MIN_TOUCH}` });
      }
    }
    for (const c of n.children ?? []) if (typeof c !== 'string') walk(c, here);
  };
  for (const n of Array.isArray(root) ? root : root ? [root] : []) walk(n, '');
  if ((opts.header ?? true) && headers === 0) issues.push({ rule: 'header', path: '/', detail: 'no accessibilityRole="header" on the screen' });
  return issues;
}
