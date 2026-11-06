import { type Company, type Plant, plantRule, type Role, type User } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import {
  pickerPlantLabel,
  ROLE_CHOICES,
  rolePreview,
  shortPlantLabel,
  supervisorCaption,
} from '../../admin/forms';
import { byCode } from '../../api/hooks/companies';
import { useTheme } from '../../theme/ThemeProvider';
import { type AvatarTone, ChoiceCard, ChoiceRow, Group, Header, Text } from '../../ui';

/** Role colour, shared by avatar and badge (canvas Users & roles). */
export const ROLE_TONE: Record<Role, AvatarTone & ('br' | 'vi' | 'te' | 'wn')> = {
  owner: 'br',
  city_staff: 'vi',
  plant_head: 'te',
  supervisor: 'wn',
};

/** Back to the previous screen, or to More when the screen was opened directly (deep link). */
export function BackHeader({ right }: { right?: React.ReactNode }) {
  const router = useRouter();
  return (
    <Header
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/more'))}
      right={right}
    />
  );
}

/** Plants an admin can give access to: active ones of active companies, by unit code. */
export function assignablePlants(
  companies: readonly Company[] | undefined,
  plants: readonly Plant[] | undefined,
  keep: readonly string[] = [],
): { plant: Plant; company: Company | undefined }[] {
  if (!plants) return [];
  const order = byCode(companies ?? []);
  return plants
    .map((plant) => ({ plant, company: companies?.find((c) => c.id === plant.companyId) }))
    .filter(
      ({ plant, company }) =>
        keep.includes(plant.id) || (plant.active && (company?.active ?? false)),
    )
    .sort((a, b) => {
      const ca = order.findIndex((c) => c.id === a.company?.id);
      const cb = order.findIndex((c) => c.id === b.company?.id);
      return ca - cb || a.plant.name.localeCompare(b.plant.name);
    });
}

/** Plants to keep when the role changes: none for all-unit roles, and too many for one is none. */
export function plantsAfterRoleChange(role: Role, plantIds: readonly string[]): string[] {
  const rule = plantRule(role);
  if (rule.max === 0) return [];
  return plantIds.length <= rule.max ? [...plantIds] : [];
}

/**
 * Role cards, the plant picker that obeys the role's plant rule (one radio list for a supervisor,
 * checkboxes for a plant head, nothing for all-unit roles) and the live "will be able to" box.
 */
export function AccessFields({
  name,
  role,
  plantIds,
  onChange,
  companies,
  plants,
  users,
  plantError,
  locked,
  excludeUserId,
}: {
  name: string;
  role: Role | undefined;
  plantIds: string[];
  onChange(next: { role: Role; plantIds: string[] }): void;
  companies: Company[] | undefined;
  plants: Plant[] | undefined;
  users: User[] | undefined;
  plantError?: string;
  /** The person's own account: shown, not changeable. */
  locked?: boolean;
  /** Leave this user out of "1 supervisor already" (the one being edited). */
  excludeUserId?: string;
}) {
  const options = assignablePlants(companies, plants, plantIds);
  const rule = role ? plantRule(role) : null;
  const others = (users ?? []).filter((u) => u.id !== excludeUserId);
  const labels = plantIds.flatMap((id) => {
    const o = options.find((x) => x.plant.id === id);
    return o ? [shortPlantLabel(o.plant, o.company)] : [];
  });

  return (
    <>
      <View style={styles.field} accessibilityRole="radiogroup" accessibilityLabel="Role">
        <Text variant="caption" weight="medium" color="tx2" style={styles.label}>
          Role
        </Text>
        {ROLE_CHOICES.map((c) => (
          <ChoiceCard
            key={c.role}
            title={c.label}
            detail={c.detail}
            checked={role === c.role}
            disabled={locked}
            onPress={() =>
              onChange({ role: c.role, plantIds: plantsAfterRoleChange(c.role, plantIds) })
            }
          />
        ))}
      </View>

      {role && rule && rule.max > 0 ? (
        <View style={styles.field}>
          <Text variant="caption" weight="medium" color="tx2" style={styles.label}>
            Plant access
          </Text>
          {options.length === 0 ? (
            <Text color="tx2">Add a plant under Companies &amp; units first.</Text>
          ) : (
            <Group>
              {options.map(({ plant, company }) => {
                const checked = plantIds.includes(plant.id);
                const single = rule.max === 1;
                return (
                  <ChoiceRow
                    key={plant.id}
                    kind={single ? 'radio' : 'checkbox'}
                    title={pickerPlantLabel(plant, company)}
                    detail={
                      role === 'supervisor' ? supervisorCaption(plant.id, others) : plant.location
                    }
                    checked={checked}
                    disabled={locked}
                    onPress={() => {
                      const next = single
                        ? [plant.id]
                        : checked
                          ? plantIds.filter((id) => id !== plant.id)
                          : [...plantIds, plant.id];
                      onChange({ role, plantIds: next });
                    }}
                  />
                );
              })}
            </Group>
          )}
          {plantError ? (
            <Text
              variant="caption"
              color="dgt"
              accessibilityLiveRegion="polite"
              style={styles.label}
            >
              {plantError}
            </Text>
          ) : (
            <Text variant="caption" style={styles.label}>
              {rule.max === 1
                ? 'Supervisors are locked to one plant. City staff see every unit.'
                : 'Plant heads see orders and dispatch of the plants ticked here.'}
            </Text>
          )}
        </View>
      ) : null}

      {role ? <PermissionPreview role={role} name={name} plantLabels={labels} /> : null}
    </>
  );
}

/** "Deepak will be able to ✓ … ✕ …" from the shared policy text. */
export function PermissionPreview({
  role,
  name,
  plantLabels,
  title,
}: {
  role: Role;
  name: string;
  plantLabels: string[];
  title?: string;
}) {
  const { t } = useTheme();
  const p = rolePreview(role, name, plantLabels);
  return (
    <View style={[styles.preview, { backgroundColor: t.card, borderColor: t.bd }]}>
      <Text variant="overline">{title ?? p.title}</Text>
      <PermissionList can={p.can} cannot={p.cannot} />
    </View>
  );
}

export function PermissionList({ can, cannot }: { can: string[]; cannot: string[] }) {
  return (
    <View style={styles.list}>
      {can.map((s) => (
        <View key={`c${s}`} style={styles.line} accessible accessibilityLabel={`Can: ${s}`}>
          <Text weight="semibold" color="okt" style={styles.mark}>
            ✓
          </Text>
          <Text style={styles.fill}>{s}</Text>
        </View>
      ))}
      {cannot.map((s) => (
        <View key={`x${s}`} style={styles.line} accessible accessibilityLabel={`Cannot: ${s}`}>
          <Text weight="semibold" color="dgt" style={styles.mark}>
            ✕
          </Text>
          <Text color="tx2" style={styles.fill}>
            {s}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Error or info line under a form (live region so TalkBack reads it). */
export function FormMessage({ children }: { children?: string }) {
  if (!children) return null;
  return (
    <Text color="dgt" accessibilityRole="alert" accessibilityLiveRegion="polite">
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  field: { gap: 8 },
  label: { paddingHorizontal: 4 },
  preview: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 10 },
  list: { gap: 8 },
  line: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  mark: { width: 14 },
});

/** Toast when a retry replayed an earlier try that had different details (its answer was lost). */
export const firstTryNote = (what: string) =>
  `Your first try went through as ${what}. Check the details.`;
