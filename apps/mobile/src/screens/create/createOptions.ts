import type { Action } from '@tonnage/shared';
import type { Href } from 'expo-router';
import type { IconName, Tone } from '../../ui';

export type CreateKey = 'order' | 'loading' | 'customer' | 'broker' | 'product' | 'transporter';

export interface CreateOption {
  key: CreateKey;
  label: string;
  caption: string;
  icon: IconName;
  /** Icon tile colour; `primary` is the filled lead tile. */
  tone: Tone | 'primary';
  /** Spans both grid columns. */
  wide?: boolean;
  /** What the person must be allowed (shared `policy.ts`) to see the tile. */
  action: Action;
  href: Href;
}

/** Canvas board 39, in grid order. */
export const CREATE_OPTIONS: readonly CreateOption[] = [
  { key: 'order', label: 'Order', caption: 'Book material across companies', icon: 'orders', tone: 'primary', wide: true, action: 'order.create', href: '/order-form' },
  { key: 'loading', label: 'Loading', caption: 'Truck against an open order', icon: 'truck', tone: 'am', action: 'truck.assign', href: '/pick-loading' },
  { key: 'customer', label: 'Customer', caption: 'Bill-to, ship-to, contacts', icon: 'building', tone: 'bl', action: 'masters.manage', href: { pathname: '/parties/form', params: { type: 'customer' } } },
  { key: 'broker', label: 'Broker', caption: 'Commission per MT, contacts', icon: 'userPlus', tone: 'vi', action: 'masters.manage', href: { pathname: '/parties/form', params: { type: 'broker' } } },
  { key: 'product', label: 'Product', caption: 'Size, lengths, conversion', icon: 'box', tone: 'gr', action: 'masters.manage', href: '/products/form' },
  { key: 'transporter', label: 'Transporter', caption: 'Name, contact numbers', icon: 'van', tone: 'te', wide: true, action: 'masters.manage', href: { pathname: '/parties/form', params: { type: 'transporter' } } },
];

/** The tiles a person may use, given their permission check (`(a) => can(role, a)`). */
export function createOptionsFor(allowed: (action: Action) => boolean): CreateOption[] {
  return CREATE_OPTIONS.filter((o) => allowed(o.action));
}
