/// <reference path="../../dist/sdk.d.ts" />
// The global `DegenHive`, as a game that does not import anything sees it.

DegenHive.ready();
const r = DegenHive.random(1);
const x: number = r();
void x;
const w: Window["DegenHive"] = window.DegenHive;
void w;
window.addEventListener("degenhive:ready", (e) => {
  const v: string = e.detail.version;
  void v;
});
