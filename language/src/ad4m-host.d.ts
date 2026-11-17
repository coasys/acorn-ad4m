// Types for the subset of `ad4m:host` this language uses
// (rust-executor/src/js_core/host.js in the ad4m repo).
declare module "ad4m:host" {
  export function holochainRegisterDnas(
    dnas: Array<{
      nick: string;
      file?: Uint8Array;
      path?: string;
      network_seed?: string;
    }>
  ): Promise<any[]>;
  export function holochainCall(
    dnaNick: string,
    zome: string,
    fnName: string,
    params: any
  ): Promise<any>;
  export function agentDid(): string;
  export function emitSignal(data: any): void;
  export function languageAddress(): string;
}
