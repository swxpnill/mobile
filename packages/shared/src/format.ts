/** Indian digit grouping for a string of digits: last 3, then groups of 2 (12,48,640). */
export function groupIndian(intDigits: string): string {
  if (intDigits.length <= 3) return intDigits;
  const head = intDigits.slice(0, -3);
  const tail = intDigits.slice(-3);
  const groups: string[] = [];
  for (let end = head.length; end > 0; end -= 2) {
    groups.unshift(head.slice(Math.max(0, end - 2), end));
  }
  return `${groups.join(',')},${tail}`;
}
