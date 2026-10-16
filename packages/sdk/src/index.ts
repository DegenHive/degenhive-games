import { createSDK } from "./core";
import type { DegenHiveApi } from "./types";

export type * from "./types";

/** The SDK is a singleton: a second copy of this file reuses the one on the page. */
function boot(): DegenHiveApi {
  const w: any = window;
  if (w.DegenHive) return w.DegenHive;
  const api = createSDK();
  w.DegenHive = api;
  w.dispatchEvent(new CustomEvent("degenhive:ready", { detail: api }));
  return api;
}

const DegenHive = boot();

export default DegenHive;
export { DegenHive };
