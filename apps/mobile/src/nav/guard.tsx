import { type Action, can } from '@tonnage/shared';
import { Redirect } from 'expo-router';
import type { ReactNode } from 'react';
import { useMe } from '../api/hooks/me';
import { firstTab } from './tabs';

/**
 * Renders its screen only for roles allowed `action` (shared `policy.ts`, the same rules the API
 * enforces). Anyone else — e.g. a supervisor following a deep link to an admin screen — lands on
 * their own first tab. The API would refuse the data anyway; this keeps them off a dead screen.
 */
export function RequireAction({ action, children }: { action: Action; children: ReactNode }) {
  const { data: me } = useMe();
  if (!me) return null; // profile still loading
  if (!can(me.role, action)) return <Redirect href={`/${firstTab(me.role)}`} />;
  return <>{children}</>;
}
