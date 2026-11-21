// Runs in every test file after the framework loads: process-wide state that must not leak
// from one test into the next.
import { resetSyncLockForTests } from '../src/offline/syncLock';

beforeEach(() => resetSyncLockForTests());
