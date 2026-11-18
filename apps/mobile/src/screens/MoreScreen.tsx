import { can, formatRupeesShort } from '@tonnage/shared';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useCompanies } from '../api/hooks/companies';
import { useMe } from '../api/hooks/me';
import { useBrokerDues } from '../api/hooks/money';
import { useRejectionCount } from '../api/hooks/rejections';
import { demoToolsEnabled } from '../api/demo';
import { Group, MenuRow, Screen, SectionLabel } from '../ui';
import { ProfileCard } from './ProfileCard';
import { SignOutRow } from './SignOutRow';

/**
 * Canvas "More menu". Sections follow the shared policy, so each role sees what it may use:
 * Masters for those who manage them, money rows only for roles that see money, Admin for the
 * owner. Screens that arrive in later milestones show as "Coming soon".
 */
export function MoreScreen() {
  const router = useRouter();
  const { data: me } = useMe();
  const { data: companies } = useCompanies();
  const { data: rejections } = useRejectionCount();
  const { data: dues } = useBrokerDues();
  if (!me)
    return (
      <Screen title="More" edges={['top']}>
        {null}
      </Screen>
    );
  const role = me.role;
  const money = can(role, 'money.view');
  const hasMoneySection = money || can(role, 'reports.view') || can(role, 'import.run');
  const duesText = dues
    ? dues.totalDueRupees > 0
      ? `${formatRupeesShort(dues.totalDueRupees)} due`
      : 'Nothing due'
    : undefined;

  return (
    <Screen title="More" edges={['top']}>
      <ProfileCard />

      {can(me.role, 'rejections.manage') ? (
        // Ruling 8: weights the server refused, for the owner to restore or dismiss.
        <Group>
          <MenuRow
            icon="alert"
            tone="rd"
            label="Needs attention"
            badge={rejections?.open}
            accessibilityLabel={`Needs attention · ${rejections === undefined ? 'loading' : `${rejections.open} open`}`}
            onPress={() => router.push('/attention')}
          />
        </Group>
      ) : null}

      {can(role, 'masters.manage') ? (
        <>
          <SectionLabel>Masters</SectionLabel>
          <Group>
            <MenuRow
              icon="users"
              tone="bl"
              label="Customers & brokers"
              onPress={() => router.push({ pathname: '/parties', params: { type: 'customer' } })}
            />
            <MenuRow
              icon="truck"
              tone="te"
              label="Transporters"
              onPress={() => router.push({ pathname: '/parties', params: { type: 'transporter' } })}
            />
            <MenuRow icon="box" tone="vi" label="Products" onPress={() => router.push('/products')} />
          </Group>
        </>
      ) : null}

      {hasMoneySection ? (
        <>
          <SectionLabel>{money ? 'Money & reports' : 'Reports'}</SectionLabel>
          <Group>
            {money ? (
              // Ruling 8: the total due to brokers (advances do not offset it), short above a lakh.
              <MenuRow
                icon="wallet"
                tone="am"
                label="Broker ledger"
                value={duesText}
                valueColor={dues && dues.totalDueRupees > 0 ? 'wnt' : undefined}
                accessibilityLabel={duesText ? `Broker ledger · ${duesText}` : 'Broker ledger'}
                onPress={() => router.push('/brokers')}
              />
            ) : null}
            {can(role, 'reports.view') ? (
              <MenuRow icon="chart" tone="gr" label="Reports" onPress={() => router.push('/reports')} />
            ) : null}
            {can(role, 'import.run') ? (
              <MenuRow icon="upload" tone="gr" label="Import from Excel" comingSoon />
            ) : null}
          </Group>
        </>
      ) : null}

      {can(role, 'users.manage') ? (
        <>
          <SectionLabel>Admin · owner only</SectionLabel>
          <Group>
            <MenuRow
              icon="factory"
              tone="bl"
              label="Companies & units"
              value={companies ? String(companies.length) : undefined}
              onPress={() => router.push('/companies')}
            />
            <MenuRow
              icon="shield"
              tone="vi"
              label="Users & roles"
              onPress={() => router.push('/users')}
            />
            <MenuRow
              icon="sliders"
              tone="gy"
              label="Settings"
              onPress={() => router.push('/settings')}
            />
          </Group>
        </>
      ) : (
        // Everyone can change theme, text size and units.
        <Group>
          <MenuRow
            icon="sliders"
            tone="gy"
            label="Settings"
            onPress={() => router.push('/settings')}
          />
        </Group>
      )}

      <Group>
        {demoToolsEnabled() ? (
          <MenuRow
            icon="grid"
            tone="am"
            label="Demo tools"
            onPress={() => router.push('/demo-tools')}
          />
        ) : null}
        <MenuRow
          icon="info"
          tone="gr"
          label="Tonnage"
          value={`v${Constants.expoConfig?.version ?? '1.0.0'}`}
          onPress={() => router.push('/design-kit')}
        />
        <SignOutRow />
      </Group>
    </Screen>
  );
}
