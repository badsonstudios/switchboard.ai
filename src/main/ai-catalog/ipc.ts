// The `ais:*` channels (E40 item 08, #1291) — what the AIs tab (#1292) and the
// session icons (#1293) ask. The push half, `ais:changed`, is sent through
// the `push` the service was built with (`index.ts`).
//
// Capabilities (`shared/ipc/capabilities.ts`), named for what each DOES:
//   - reading the list and the default is `settings.read`;
//   - choosing the default and removing an entry is `settings.write`;
//   - "Look again" runs each AI's version / sign-in check: `environment.probe`;
//   - adding a "Something else", testing one, and running a sign-in each
//     define or START A PROGRAM: `sessions.spawn`;
//   - "Check for new AIs" is one unauthenticated GET of a public JSON file:
//     `provider.status`, the word for exactly that.
import type { IpcBroker } from '../ipc/broker';
import type { AiCatalogService } from './service';

export function registerAisIpc(broker: IpcBroker, service: AiCatalogService): void {
  broker.handle('ais:list', () => service.list());
  broker.handle('ais:default', () => service.defaultState());
  broker.handle('ais:setDefault', (_e, id: unknown) => service.setDefault(id));
  broker.handle('ais:lookAgain', () => service.detectAll('look again'));
  broker.handle('ais:checkRegistry', () => service.checkRegistry());
  broker.handle('ais:lastRegistryCheck', () => service.lastRegistryCheck());
  broker.handle('ais:customAdd', (_e, draft: unknown) => service.addCustom(draft));
  broker.handle('ais:customRemove', (_e, id: unknown) => service.removeCustom(id));
  broker.handle('ais:customTest', (_e, draft: unknown) => service.testCustom(draft));
  broker.handle('ais:login', (_e, providerId: unknown, methodId?: unknown) => service.login(providerId, methodId));
}
