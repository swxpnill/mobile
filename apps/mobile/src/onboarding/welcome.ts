import { type Company, type Plant, type Role, type UnitBasis, toDisplayQty, unitLabel } from '@tonnage/shared';
import { ROLE_SHORT, scopeLine } from '../nav/roles';

/**
 * Board 41 holds this long once its entrance has finished, then fades. Not tapped away (user decisions 2026-11-27: 1.5 s).
 */
export const WELCOME_SHOW_MS = 1500;
export const WELCOME_FADE_MS = 250;
/** The entrance (logo into its tile, then the words), before the hold starts. */
export const WELCOME_ENTER_MS = 900;
/** Safety net from mount, should the layout event never come: the app is never held behind it. */
export const WELCOME_CAP_MS = 4500;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The one live line under the name, from data the app already loads. */
export function welcomeLine(
  role: Role,
  data: { pendingKg?: number; inPlant?: number; waiting?: number },
  basis: UnitBasis,
): string {
  const loading = 'Getting today’s work ready…';
  switch (role) {
    case 'owner':
    case 'city_staff':
      if (data.pendingKg === undefined) return loading;
      return data.pendingKg > 0
        ? `${toDisplayQty(data.pendingKg, basis)} ${unitLabel(basis)} pending to dispatch`
        : 'Nothing pending to dispatch';
    case 'plant_head':
      return data.inPlant === undefined ? loading : `${plural(data.inPlant, 'truck', 'trucks')} in plant now`;
    case 'supervisor':
      if (data.waiting === undefined) return loading;
      return data.waiting > 0 ? `${plural(data.waiting, 'truck', 'trucks')} waiting for you` : 'No trucks waiting yet';
  }
}

/** "Owner · All units", "Supervisor · Aarav · Siltara". */
export function roleBadge(
  role: Role,
  plantIds: string[],
  companies: Company[] | undefined,
  plants: Plant[] | undefined,
): string {
  const scope =
    role === 'owner' || role === 'city_staff' ? 'All units' : scopeLine(role, plantIds, companies, plants);
  return scope ? `${ROLE_SHORT[role]} · ${scope}` : ROLE_SHORT[role];
}

let welcomedThisRun = false;

/** True the first time it is asked in this app run (a reopened app greets once). */
export function takeColdStartWelcome(): boolean {
  if (welcomedThisRun) return false;
  welcomedThisRun = true;
  return true;
}

/** Demo tools "Replay first sign-in", and tests: the next resumed session is greeted again. */
export function rearmWelcome(): void {
  welcomedThisRun = false;
}
