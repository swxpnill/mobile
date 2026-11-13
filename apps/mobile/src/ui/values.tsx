import { formatRupees, formatRupeesShort, toDisplayQty, type UnitBasis } from '@tonnage/shared';
import { useDisplayBasis } from '../api/hooks/me';
import { Text, type TextProps } from './Text';

/**
 * A quantity stored as integer kg, shown in the user's unit basis (MT or kg, from their profile).
 * Pass `basis` only to force one, e.g. in a unit-switcher preview.
 */
export function QtyText({
  kg,
  basis,
  withUnit,
  ...rest
}: { kg: number; basis?: UnitBasis; withUnit?: boolean } & Omit<TextProps, 'children'>) {
  const current = useDisplayBasis();
  return (
    <Text numeric {...rest}>
      {toDisplayQty(kg, basis ?? current, { withUnit })}
    </Text>
  );
}

/**
 * Integer rupees, Indian grouping (₹55,80,000) or short (₹55.80 L). Renders nothing when the
 * amount is missing: the server omits money for plant heads and supervisors (spec §5.5), so
 * screens pass the field through without checking roles.
 */
export function MoneyText({
  rupees,
  short,
  ...rest
}: { rupees: number | undefined; short?: boolean } & Omit<TextProps, 'children'>) {
  if (rupees === undefined) return null;
  return (
    <Text numeric {...rest}>
      {short ? formatRupeesShort(rupees) : formatRupees(rupees)}
    </Text>
  );
}
