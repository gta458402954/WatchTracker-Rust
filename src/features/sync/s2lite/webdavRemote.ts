/** Transport-only S2 WebDAV mapper.  It deliberately has no receipt policy. */
import type { ImmutableObjectRemoteV1, RemoteExactGetResultV1, RemotePutResultV1 } from './immutablePublish.ts';
import type { DirectoryListResultV1, DiscoveryExactGetResultV1, DiscoveryRemoteV1 } from './remoteDiscovery.ts';

export type S2WebDavWireResult =
  | { kind: 'present'; bytes: Uint8Array }
  | { kind: 'absent' }
  | { kind: 'auth' }
  | { kind: 'indeterminate' }
  | { kind: 'put-success' }
  | { kind: 'entries'; entries: string[] };

export interface S2WebDavWireTransport {
  readonly physicalRootId: string;
  get(path: string): Promise<S2WebDavWireResult>;
  put(path: string, bytes: Uint8Array, defenseInDepth: { ifNoneMatchStar: true }): Promise<S2WebDavWireResult>;
  propfindDepthOne(path: string): Promise<S2WebDavWireResult>;
}

function getResult(value: S2WebDavWireResult): RemoteExactGetResultV1 {
  if (value.kind === 'present') return { state: 'DefinitelyPresent', bytes: Uint8Array.from(value.bytes) };
  if (value.kind === 'absent') return { state: 'DefinitelyAbsent' };
  if (value.kind === 'auth') return { state: 'AuthOrCapabilityFailure' };
  if (value.kind === 'indeterminate') return { state: 'Indeterminate' };
  throw new Error(`invalid WebDAV GET result: ${value.kind}`);
}

/** Maps only conservative transport outcomes into the frozen interfaces. */
export function createS2WebDavRemote(transport: S2WebDavWireTransport): ImmutableObjectRemoteV1 & DiscoveryRemoteV1 & { physicalRootId: string } {
  return {
    physicalRootId: transport.physicalRootId,
    async getExact(path: string) { return getResult(await transport.get(path)); },
    async putExact(path: string, bytes: Uint8Array, defenseInDepth: { ifNoneMatchStar: true }): Promise<RemotePutResultV1> {
      const value = await transport.put(path, Uint8Array.from(bytes), defenseInDepth);
      if (value.kind === 'put-success') return { state: 'Success' };
      if (value.kind === 'auth') return { state: 'AuthOrCapabilityFailure' };
      if (value.kind === 'indeterminate') return { state: 'Indeterminate' };
      throw new Error(`invalid WebDAV PUT result: ${value.kind}`);
    },
    async listDirectory(path: string): Promise<DirectoryListResultV1> {
      const value = await transport.propfindDepthOne(path);
      if (value.kind === 'entries') return { state: 'Entries', entries: [...new Set(value.entries)].sort() };
      if (value.kind === 'auth') return { state: 'AuthOrCapabilityFailure' };
      if (value.kind === 'indeterminate') return { state: 'Indeterminate' };
      throw new Error(`invalid WebDAV PROPFIND result: ${value.kind}`);
    },
  };
}

export function mapDiscoveryGetResult(value: S2WebDavWireResult): DiscoveryExactGetResultV1 {
  const mapped = getResult(value);
  if (mapped.state === 'DefinitelyPresent') return mapped;
  if (mapped.state === 'DefinitelyAbsent') return mapped;
  if (mapped.state === 'AuthOrCapabilityFailure') return mapped;
  return { state: 'Indeterminate' };
}
