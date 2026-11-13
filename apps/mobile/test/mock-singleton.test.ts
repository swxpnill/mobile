// Hot reload re-runs modules; the in-app mock must survive it, or reads and writes split
// between two copies (seen on the emulator: a short close saved, the screen still stale).
/* eslint-disable @typescript-eslint/no-require-imports -- isolateModules needs a synchronous load */
type TransportModule = typeof import('../src/api/transport');

it('getMockApi returns the same mock after its module is loaded again', async () => {
  let a: TransportModule | undefined;
  let b: TransportModule | undefined;
  jest.isolateModules(() => {
    a = require('../src/api/transport') as TransportModule;
  });
  jest.isolateModules(() => {
    b = require('../src/api/transport') as TransportModule;
  });
  expect(a).not.toBe(b); // two module instances, as after Fast Refresh
  expect(await b!.getMockApi()).toBe(await a!.getMockApi());
});
