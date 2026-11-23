import { dialLink, telLink, whatsappLink } from '../src/format/contactLinks';

// TON-57 Ruling 11: links only for a normalised Indian mobile; anything else gets no button.
describe('contact links', () => {
  it('a call link for +91 and ten digits starting 6–9', () => {
    expect(telLink('+919826100014')).toBe('tel:+919826100014');
    expect(telLink('+916000000000')).toBe('tel:+916000000000');
  });

  it('a WhatsApp link with the text encoded', () => {
    expect(whatsappLink('+919826100014', 'CG 04 MK 2291 · SO-2611-0142-A · Loading')).toBe(
      'https://wa.me/919826100014?text=CG%2004%20MK%202291%20%C2%B7%20SO-2611-0142-A%20%C2%B7%20Loading',
    );
  });

  it('no link for anything that is not a normalised Indian mobile', () => {
    for (const bad of ['', '12345', '9826100014', '+15551234567', '+910123456789', '+9198261000145', '+91 98261 00014']) {
      expect([bad, telLink(bad)]).toEqual([bad, null]);
      expect([bad, whatsappLink(bad, 'x')]).toEqual([bad, null]);
    }
  });

  it('a vehicle request message keeps its line breaks, bullets and ampersands intact (%0A, %26)', () => {
    const text = 'Namaste R.K. ji,\n• 12 mm — 24.000 MT & more';
    const link = whatsappLink('+919926830011', text);
    expect(link).toBe(`https://wa.me/919926830011?text=${encodeURIComponent(text)}`);
    expect(link).toContain('%0A');
    expect(link).toContain('%26');
    expect(link?.split('?text=')[1]).not.toMatch(/[\n&]/);
  });

  it('Request vehicle dials any saved number, a landline too', () => {
    expect(dialLink('+917122551234')).toBe('tel:+917122551234');
    expect(dialLink('+91 98261 00501')).toBe('tel:+919826100501');
    expect(dialLink('')).toBeNull();
  });
});
