import { formatRupees, formatRupeesShort, toDisplayQty, type UnitBasis } from '@tonnage/shared';
import { Text, type TextProps } from './Text';

/**
 * A quantity stored as integer kg, shown in the user's unit basis. Until the app shell provides
 * `useUnitBasis()` (Task 8) the basis is a prop, defaulting to MT.
 */
export function QtyText({
  kg,
  basis = 'mt',
  withUnit,
  ...rest
}: { kg: number; basis?: UnitBasis; withUnit?: boolean } & Omit<TextProps, 'children'>) {
  return (
    <Text numeric {...rest}>
      {toDisplayQty(kg, basis, { withUnit })}
    </Text>
  );
}

/** Integer rupees, Indian grouping (₹55,80,000) or short (₹55.80 L). */
export function MoneyText({
  rupees,
  short,
  ...rest
}: { rupees: number; short?: boolean } & Omit<TextProps, 'children'>) {
  return (
    <Text numeric {...rest}>
      {short ? formatRupeesShort(rupees) : formatRupees(rupees)}
    </Text>
  );
}
