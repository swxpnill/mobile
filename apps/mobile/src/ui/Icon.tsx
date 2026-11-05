import Svg, { Path } from 'react-native-svg';

/** Stroke icons copied from the canvas (24×24 grid, 1.75 stroke). Add paths as screens need them. */
const PATHS = {
  back: ['m15 18-6-6 6-6'],
  plus: ['M5 12h14M12 5v14'],
  check: ['M20 6 9 17l-5-5'],
  chevronRight: ['m9 18 6-6-6-6'],
  orders: [
    'M8 2h8v4H8z',
    'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2',
    'M12 11h4M12 16h4M8 11h.01M8 16h.01',
  ],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 22,
  color,
  strokeWidth = 1.75,
}: {
  name: IconName;
  size?: number;
  color: string;
  strokeWidth?: number;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" accessible={false}>
      {PATHS[name].map((d) => (
        <Path
          key={d}
          d={d}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}
