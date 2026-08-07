// Smoke test: hits a running app instance and asserts the state contract.
// CI boots the server against the exported starter kit first.
//   PORT=4599 node scripts/smoke.mjs

const port = process.env.PORT || 4599;
const url = `http://127.0.0.1:${port}/api/state`;

let state;
for (let i = 0; i < 20; i++) {
  try { state = await (await fetch(url)).json(); break; }
  catch { await new Promise(r => setTimeout(r, 300)); }
}
if (!state) { console.error("✗ server never answered on", url); process.exit(1); }

const assert = (cond, msg) => { if (!cond) { console.error("✗ " + msg); process.exit(1); } console.log("✓ " + msg); };

assert(Array.isArray(state.vehicles) && state.vehicles.length >= 1, "at least one vehicle");
assert(state.progression.stages.length === 6, "6 progression stages");
assert(state.progression.stages.flatMap(s => s.concepts).length >= 25, "concept rows parsed");
assert(state.progression.milestones.length >= 5, "milestones parsed");
assert(state.userMath.parameters.length >= 1, "user math parameters present");
assert(typeof state.version === "string" && /^\d+\.\d+\.\d+$/.test(state.version), "version reported: " + state.version);
assert(Array.isArray(state.platforms) && state.platforms.some(p => p.id === "gm-gen3"), "gm-gen3 platform metadata loaded");
assert(Array.isArray(state.definitions), "definitions list present");

const bad = await (await fetch(`http://127.0.0.1:${port}/api/analyze?path=README.md`)).json();
assert(bad.analyzable === false, "analyze rejects non-bin cleanly");

const cmp = await fetch(`http://127.0.0.1:${port}/api/compare?a=nope.bin&b=also-nope.bin`);
assert(cmp.status === 404, "compare 404s cleanly on missing files");

const cl = await (await fetch(`http://127.0.0.1:${port}/api/checklist`)).json();
assert(cl.sections?.length > 0 && cl.sections.every(s => s.items.length), "checklist parses into sections with items");

assert(state.preferences?.units?.temperature, "unit preferences present in state: " + state.preferences?.units?.temperature);
assert(state.quantities?.temperature?.units?.length >= 2, "convertible quantities advertised");

const badPref = await fetch(`http://127.0.0.1:${port}/api/preferences`, {
  method: "POST", body: JSON.stringify({ units: { temperature: "kelvin" } }),
});
assert(badPref.status === 400, "invalid unit rejected");

assert(Array.isArray(state.scanner?.files), "scanner configs present in state");
assert(typeof state.scanner?.dictionary === "object", "channel dictionary present");

const badXdf = await (await fetch(`http://127.0.0.1:${port}/api/xdf?path=README.md`)).json();
assert(badXdf.ok === false || badXdf.tableCount === 0, "xdf endpoint handles a non-XDF file without throwing");

const badFlash = await fetch(`http://127.0.0.1:${port}/api/flashed`, {
  method: "POST", body: JSON.stringify({ vehicle: state.vehicles[0].id, rev: "v001", checked: [] }),
});
assert(badFlash.status === 400, "flash rejected when checklist incomplete");
console.log("smoke test passed");
