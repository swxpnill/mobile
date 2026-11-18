import { fireEvent, render, screen } from '@testing-library/react-native';
import { parseQtyInput, type UnitBasis } from '@tonnage/shared';
import { useState } from 'react';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { Keypad, WeightReadout, pressKey } from '../src/ui/Keypad';

function Pad({ basis, initial = '' }: { basis: UnitBasis; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <ThemeProvider>
      <WeightReadout value={value} basis={basis} />
      <Keypad value={value} onChange={setValue} basis={basis} />
    </ThemeProvider>
  );
}

const press = (label: string) => fireEvent.press(screen.getByRole('button', { name: label }));
const readout = () => screen.getByTestId('weight-readout');

describe('Keypad (Review Focus 5)', () => {
  it('MT: 3 6 . 6 4 0 5 gives 36.640 (a 4th decimal is refused) and parses to 36 640 kg', async () => {
    await render(<Pad basis="mt" />);
    for (const k of ['3', '6', 'Decimal point', '6', '4', '0', '5']) await press(k);
    expect(readout()).toHaveTextContent(/^36\.640/);
    expect(parseQtyInput('36.640', 'mt')).toEqual({ ok: true, value: 36_640 });
  });

  it('kg: no decimal key; an 8th character is refused; the same weight is the same integer kg', async () => {
    await render(<Pad basis="kg" />);
    expect(screen.queryByRole('button', { name: 'Decimal point' })).toBeNull();
    for (const k of ['3', '6', '6', '4', '0']) await press(k);
    expect(readout()).toHaveTextContent(/^36640/);
    expect(parseQtyInput('36640', 'kg')).toEqual({ ok: true, value: 36_640 });
    for (const k of ['1', '2', '3']) await press(k);
    expect(readout()).toHaveTextContent(/^3664012/); // 7 characters, the 8th dropped
  });

  it('MT: an 8th character is refused, the decimal point counts as one', async () => {
    await render(<Pad basis="mt" initial="1234.56" />);
    await press('7');
    expect(readout()).toHaveTextContent(/^1234\.56(?!7)/);
  });

  it('Delete removes the last character; the readout is a polite live region', async () => {
    await render(<Pad basis="mt" initial="12.4" />);
    await press('Delete');
    expect(readout()).toHaveTextContent(/^12\./);
    expect(readout().props.accessibilityLiveRegion).toBe('polite');
  });

  it('pressKey: one decimal point, a leading 0 before it, no leading zeros', () => {
    expect(pressKey('', '.', 'mt')).toBe('0.');
    expect(pressKey('3.', '.', 'mt')).toBe('3.');
    expect(pressKey('0', '5', 'mt')).toBe('5');
    expect(pressKey('12', '.', 'kg')).toBe('12');
    expect(pressKey('', 'del', 'kg')).toBe('');
  });
});
