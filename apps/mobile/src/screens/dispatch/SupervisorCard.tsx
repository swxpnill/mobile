import type { PlantSupervisor, Truck } from '@tonnage/shared';
import { Linking, StyleSheet, View } from 'react-native';
import { telLink, whatsappLink } from '../../format/contactLinks';
import { Avatar, Group, IconButton, Row, showToast, Text } from '../../ui';
import { TRUCK_STATE_META, shownPhone } from './truckStateMeta';

/** What a WhatsApp message to the plant starts with: which truck, which order, where it is. */
export const supervisorMessage = (x: Pick<Truck, 'vehicleNo' | 'subOrderNumber' | 'state'>) =>
  `${x.vehicleNo} · ${x.subOrderNumber} · ${TRUCK_STATE_META[x.state].label}`;

async function open(url: string, failed: string) {
  try {
    await Linking.openURL(url);
  } catch {
    showToast(failed);
  }
}

/**
 * TON-57 Ruling 11 (Dispatch detail): the active supervisors of the truck's plant, each with Call
 * and WhatsApp. Links exist only for a usable Indian mobile; otherwise the name shows with
 * "No mobile number" and no buttons. With nobody at the plant: "No supervisor at {plant} yet".
 */
export function SupervisorCard({ truck }: { truck: Pick<Truck, 'plantName' | 'supervisors' | 'vehicleNo' | 'subOrderNumber' | 'state'> }) {
  const people = truck.supervisors;
  return (
    <>
      <Text variant="heading">{`${people.length > 1 ? 'Supervisors' : 'Supervisor'} at ${truck.plantName}`}</Text>
      <Group>
        {people.length === 0 ? (
          <Row>
            <Text color="tx2" style={styles.fill}>{`No supervisor at ${truck.plantName} yet`}</Text>
          </Row>
        ) : (
          people.map((p) => <Person key={p.id} person={p} message={supervisorMessage(truck)} />)
        )}
      </Group>
    </>
  );
}

function Person({ person: p, message }: { person: PlantSupervisor; message: string }) {
  const call = telLink(p.mobile);
  const chat = whatsappLink(p.mobile, message);
  const phone = call ? shownPhone(p.mobile) : 'No mobile number';
  const caption = p.invited ? `${phone} · Not signed in yet` : phone;
  return (
    <Row>
      <View
        style={styles.who}
        accessible
        accessibilityLabel={`${p.name}, supervisor, ${phone}${p.invited ? ', not signed in yet' : ''}`}
      >
        <Avatar name={p.name} tone="br" size={36} />
        <View style={styles.fill}>
          <Text weight="medium" numberOfLines={1}>
            {p.name}
          </Text>
          <Text variant="caption" numberOfLines={1}>
            {caption}
          </Text>
        </View>
      </View>
      {call ? <IconButton icon="phone" label={`Call ${p.name}`} onPress={() => void open(call, "Couldn't start a call on this phone")} /> : null}
      {chat ? <IconButton icon="message" label={`WhatsApp ${p.name}`} onPress={() => void open(chat, "Couldn't open WhatsApp")} /> : null}
    </Row>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  who: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12 },
});
