import Svg, { Circle, Path, Rect } from 'react-native-svg';

type Shape =
  | string // a path `d`
  | { circle: [cx: number, cy: number, r: number] }
  | { rect: [x: number, y: number, w: number, h: number, rx: number] };

/** Stroke icons copied from the canvas (24×24 grid). Add shapes as screens need them. */
const ICONS = {
  back: ['m15 18-6-6 6-6'],
  chevronRight: ['m9 18 6-6-6-6'],
  plus: ['M5 12h14M12 5v14'],
  check: ['M20 6 9 17l-5-5'],
  menu: ['M4 6h16M4 12h16M4 18h16'],
  grid: [
    { rect: [3, 3, 7, 7, 1.5] },
    { rect: [14, 3, 7, 7, 1.5] },
    { rect: [14, 14, 7, 7, 1.5] },
    { rect: [3, 14, 7, 7, 1.5] },
  ],
  orders: [
    { rect: [8, 2, 8, 4, 1] },
    'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2',
    'M12 11h4M12 16h4M8 11h.01M8 16h.01',
  ],
  truck: [
    'M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2',
    'M15 18H9',
    'M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14',
    { circle: [17, 18, 2] },
    { circle: [7, 18, 2] },
  ],
  scales: [
    'm16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z',
    'm2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z',
    'M7 21h10M12 3v18M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2',
  ],
  user: [{ circle: [12, 8, 5] }, 'M20 21a8 8 0 0 0-16 0'],
  users: [
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
    { circle: [9, 7, 4] },
    'M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  ],
  box: [
    'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z',
    'm3.3 7 8.7 5 8.7-5M12 22V12',
  ],
  wallet: [
    'M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1',
    'M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4',
  ],
  chart: ['M3 3v18h18M18 17V9M13 17V5M8 17v-3'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12'],
  factory: [
    'M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z',
    'M17 18h1M12 18h1M7 18h1',
  ],
  shield: [
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
  ],
  sliders: ['M20 7h-9M14 17H5', { circle: [17, 17, 3] }, { circle: [7, 7, 3] }],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9'],
  info: [{ circle: [12, 12, 10] }, 'M12 16v-4M12 8h.01'],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

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
  const stroke = {
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" accessible={false}>
      {(ICONS[name] as Shape[]).map((s, i) => {
        if (typeof s === 'string') return <Path key={i} d={s} {...stroke} />;
        if ('circle' in s) {
          const [cx, cy, r] = s.circle;
          return <Circle key={i} cx={cx} cy={cy} r={r} {...stroke} />;
        }
        const [x, y, width, height, rx] = s.rect;
        return <Rect key={i} x={x} y={y} width={width} height={height} rx={rx} {...stroke} />;
      })}
    </Svg>
  );
}
