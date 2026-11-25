// Fails when a tracked source file is not valid UTF-8 (a Windows-1252 byte slipped in by an editor or script).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EXT = /\.(ts|tsx|js|mjs|json|md|sql|ya?ml)$/;
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter((f) => f !== '' && EXT.test(f));

/** Byte offset of the first byte that is not valid UTF-8, or -1. */
function firstInvalidOffset(bytes) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    decoder.decode(bytes);
    return -1;
  } catch {
    // Decode a growing prefix in streaming mode (a cut-off multi-byte sequence is fine) until it throws.
    let lo = 0;
    let hi = bytes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, mid + 1), { stream: true });
        lo = mid + 1;
      } catch {
        hi = mid;
      }
    }
    return lo;
  }
}

let bad = 0;
for (const file of files) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    continue; // listed by git but deleted in the working tree
  }
  const offset = firstInvalidOffset(bytes);
  if (offset >= 0) {
    console.error(`invalid UTF-8: ${file} (byte offset ${offset})`);
    bad += 1;
  }
}
if (bad > 0) process.exit(1);
console.log(`check-utf8: ${files.length} files are valid UTF-8`);
