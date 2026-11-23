import * as Clipboard from 'expo-clipboard';

/** Puts text on the phone's clipboard (the one seam, so tests and screens need no native module). */
export async function copyText(text: string): Promise<void> {
  await Clipboard.setStringAsync(text);
}
