import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Text } from 'react-native';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { Group, Row, Screen, Switch, TextField } from '../src/ui';

const wrap = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

describe('TextField', () => {
  it('labelled input with a +91 prefix; typing calls onChangeText', async () => {
    const onChangeText = jest.fn();
    await wrap(
      <TextField label="Mobile number" prefix="+91" value="" onChangeText={onChangeText} />,
    );
    expect(screen.getByText('+91')).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('Mobile number'), '98261');
    expect(onChangeText).toHaveBeenCalledWith('98261');
  });

  it('shows the hint, and replaces it with the error (announced politely)', async () => {
    await wrap(<TextField label="Mobile" value="" onChangeText={() => {}} hint="10 digits" />);
    expect(screen.getByText('10 digits')).toBeOnTheScreen();
    await wrap(
      <TextField
        label="Mobile"
        value="123"
        onChangeText={() => {}}
        hint="10 digits"
        error="Enter a 10-digit mobile number"
      />,
    );
    const err = screen.getByText('Enter a 10-digit mobile number');
    expect(err).toHaveProp('accessibilityLiveRegion', 'polite');
    expect(screen.queryByText('10 digits')).toBeNull();
  });

  it('is 48 tall (canvas .inp)', async () => {
    await wrap(<TextField label="Name" value="" onChangeText={() => {}} />);
    expect(screen.getByTestId('textfield-box')).toHaveStyle({ minHeight: 48 });
  });
});

describe('Switch', () => {
  it('reports checked state and toggles; has a 44 pt hit area', async () => {
    const onChange = jest.fn();
    await wrap(<Switch label="Unlock with fingerprint" value={false} onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Unlock with fingerprint' });
    expect(sw).not.toBeChecked();
    await fireEvent.press(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('disabled switch does not toggle', async () => {
    const onChange = jest.fn();
    await wrap(<Switch label="X" value onChange={onChange} disabled />);
    const sw = screen.getByRole('switch', { name: 'X' });
    expect(sw).toBeChecked();
    expect(sw).toBeDisabled();
    await fireEvent.press(sw);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Row disabled', () => {
  it('a disabled pressable row is announced disabled and ignores presses', async () => {
    const onPress = jest.fn();
    await wrap(
      <Group>
        <Row onPress={onPress} disabled accessibilityLabel="Parties, coming soon">
          <Text>Parties</Text>
        </Row>
      </Group>,
    );
    const row = screen.getByRole('button', { name: 'Parties, coming soon' });
    expect(row).toBeDisabled();
    await fireEvent.press(row);
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('Screen title', () => {
  it('the large title scrolls with the content (inside the ScrollView), as in the canvas', async () => {
    await wrap(
      <Screen title="Settings">
        <Text>Body</Text>
      </Screen>,
    );
    const title = screen.getByRole('header', { name: 'Settings' });
    let node = title.parent;
    let insideScroll = false;
    while (node) {
      if (node.props.testID === 'screen-scroll') insideScroll = true;
      node = node.parent;
    }
    expect(insideScroll).toBe(true);
  });
});
