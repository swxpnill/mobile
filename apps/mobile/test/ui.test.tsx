import { fireEvent, render, screen } from '@testing-library/react-native';
import { type ReactElement, useState } from 'react';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import {
  Badge,
  Button,
  Chip,
  EmptyState,
  Group,
  Header,
  MoneyText,
  OtpInput,
  QtyText,
  Row,
  SegmentedControl,
  Text,
  UnitTag,
} from '../src/ui';

const wrap = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

describe('QtyText and MoneyText', () => {
  it('24180 kg → "24.180 MT" in MT and "24,180 kg" in kg', async () => {
    await wrap(<QtyText kg={24180} basis="mt" withUnit />);
    expect(screen.getByText('24.180 MT')).toBeOnTheScreen();
    await wrap(<QtyText kg={24180} basis="kg" withUnit />);
    expect(screen.getByText('24,180 kg')).toBeOnTheScreen();
  });

  it('defaults to MT and no unit', async () => {
    await wrap(<QtyText kg={1000} />);
    expect(screen.getByText('1.000')).toBeOnTheScreen();
  });

  it('₹55.80 L short; full Indian grouping otherwise', async () => {
    await wrap(<MoneyText rupees={5580000} short />);
    expect(screen.getByText('₹55.80 L')).toBeOnTheScreen();
    await wrap(<MoneyText rupees={5580000} />);
    expect(screen.getByText('₹55,80,000')).toBeOnTheScreen();
  });
});

describe('OtpInput', () => {
  function Controlled({ onChange }: { onChange: (v: string) => void }) {
    const [v, setV] = useState('472');
    return (
      <OtpInput
        length={6}
        value={v}
        onChange={(next) => {
          setV(next);
          onChange(next);
        }}
      />
    );
  }

  it("typing '472' then '9' calls onChange('4729')", async () => {
    const onChange = jest.fn();
    await wrap(<Controlled onChange={onChange} />);
    await fireEvent.changeText(screen.getByLabelText('One-time code'), '4729');
    expect(onChange).toHaveBeenLastCalledWith('4729');
  });

  it('pasting fills all 6, ignores non-digits, caps at 6', async () => {
    const onChange = jest.fn();
    await wrap(<Controlled onChange={onChange} />);
    const input = screen.getByLabelText('One-time code');
    await fireEvent.changeText(input, '472915');
    expect(onChange).toHaveBeenLastCalledWith('472915');
    await fireEvent.changeText(input, '4 7-2a9');
    expect(onChange).toHaveBeenLastCalledWith('4729');
    await fireEvent.changeText(input, '47291583');
    expect(onChange).toHaveBeenLastCalledWith('472915');
  });

  it('shows each digit in its own box', async () => {
    await wrap(<OtpInput length={6} value="47" onChange={() => {}} />);
    expect(screen.getByTestId('otp-cell-0', { includeHiddenElements: true })).toHaveTextContent(
      '4',
    );
    expect(screen.getByTestId('otp-cell-1', { includeHiddenElements: true })).toHaveTextContent(
      '7',
    );
    expect(screen.getByTestId('otp-cell-2', { includeHiddenElements: true })).toHaveTextContent('');
  });
});

describe('SegmentedControl', () => {
  const options = [
    { value: 'mt' as const, label: 'MT' },
    { value: 'kg' as const, label: 'kg' },
  ];

  it("pressing 'kg' calls onChange('kg'); the selected option reports selected", async () => {
    const onChange = jest.fn();
    await wrap(<SegmentedControl options={options} value="mt" onChange={onChange} />);
    await fireEvent.press(screen.getByText('kg'));
    expect(onChange).toHaveBeenCalledWith('kg');
    expect(screen.getByRole('radio', { name: 'MT' })).toBeSelected();
    expect(screen.getByRole('radio', { name: 'kg' })).not.toBeSelected();
  });

  it('pressing the already-selected option does nothing', async () => {
    const onChange = jest.fn();
    await wrap(<SegmentedControl options={options} value="mt" onChange={onChange} />);
    await fireEvent.press(screen.getByText('MT'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Button', () => {
  it('loading → disabled, busy, and onPress not called', async () => {
    const onPress = jest.fn();
    await wrap(
      <Button variant="primary" loading onPress={onPress}>
        Verify and continue
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Verify and continue' });
    expect(btn).toBeDisabled();
    expect(btn).toBeBusy();
    await fireEvent.press(btn);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('enabled → onPress called; disabled → not', async () => {
    const onPress = jest.fn();
    await wrap(<Button onPress={onPress}>Send code</Button>);
    await fireEvent.press(screen.getByRole('button', { name: 'Send code' }));
    expect(onPress).toHaveBeenCalledTimes(1);
    await wrap(
      <Button onPress={onPress} disabled>
        Send again
      </Button>,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Send again' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('is 52 tall (canvas) — well above the 44 minimum touch target', async () => {
    await wrap(<Button onPress={() => {}}>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toHaveStyle({ height: 52 });
  });
});

describe('small primitives', () => {
  it('Badge, UnitTag, Chip with count and selected state', async () => {
    const onPress = jest.fn();
    await wrap(
      <>
        <Badge kind="ok" dot>
          Completed
        </Badge>
        <UnitTag code="AIP" slot={0} />
        <Chip label="Open" count={21} selected onPress={onPress} />
      </>,
    );
    expect(screen.getByText('Completed')).toBeOnTheScreen();
    expect(screen.getByText('AIP')).toBeOnTheScreen();
    const chip = screen.getByRole('button', { name: 'Open, 21' });
    expect(chip).toBeSelected();
    await fireEvent.press(chip);
    expect(onPress).toHaveBeenCalled();
  });

  it('Header back button has a label and a 44 pt target', async () => {
    const onBack = jest.fn();
    await wrap(<Header onBack={onBack} />);
    const back = screen.getByRole('button', { name: 'Back' });
    expect(back).toHaveStyle({ width: 44, height: 44 });
    await fireEvent.press(back);
    expect(onBack).toHaveBeenCalled();
  });

  it('Header with nothing to show renders no empty bar', async () => {
    await wrap(<Header />);
    expect(screen.toJSON()).toBeNull();
  });

  it('Group puts a divider between rows, not after the last', async () => {
    await wrap(
      <Group>
        <Row>
          <Text>One</Text>
        </Row>
        <Row>
          <Text>Two</Text>
        </Row>
        <Row>
          <Text>Three</Text>
        </Row>
      </Group>,
    );
    expect(screen.getAllByTestId('group-divider')).toHaveLength(2);
  });

  it('EmptyState shows title, body and actions', async () => {
    const onPress = jest.fn();
    await wrap(
      <EmptyState
        title="No orders yet"
        body="Create your first order."
        actions={[{ label: 'Create first order', onPress }]}
      />,
    );
    expect(screen.getByText('No orders yet')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Create first order' }));
    expect(onPress).toHaveBeenCalled();
  });
});
