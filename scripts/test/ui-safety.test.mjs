// Values placed into the UI's onclick="…" handlers cannot break out of them.
//
// The handlers used to be written onclick="fn('${esc(x)}')". esc() turns a
// quote into &#39;, and the browser decodes that back into a quote BEFORE the
// handler runs — so a name containing one ended the string. A VCM Scanner file
// named to carry code would have run it inside the app, which can write files
// and push to git. Handlers now use jsq(): JSON for the JavaScript, esc() for
// the attribute.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const t = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) process.exitCode = 1; };
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "public");
// the page, plus the shared renderer it loads (escaping lives there)
const html = ["index.html", "markdown.js", "print.html"].map(f => fs.readFileSync(path.join(PUB, f), "utf8")).join("\n");

console.log("— no handler uses the pattern that broke —");
{
  const handlers = [...html.matchAll(/\son(?:click|change|submit|input)="([^"]*)"/g)].map(m => m[1]);
  t(handlers.length > 30, `${handlers.length} handlers found to check`);
  const quoted = handlers.filter(h => /'\$\{/.test(h));
  t(quoted.length === 0, `none put \${…} inside quotes${quoted.length ? ": " + quoted.slice(0, 3).join(" ; ") : ""}`);
  const escOnly = handlers.filter(h => /\$\{esc\(/.test(h));
  t(escOnly.length === 0, `none rely on esc() alone${escOnly.length ? ": " + escOnly.slice(0, 3).join(" ; ") : ""}`);
}

console.log("— jsq survives the browser's decoding, whatever the value —");
{
  const grab = name => html.match(new RegExp(`^(?:const|var) ${name} = .*;$`, "m"))?.[0];
  const src = [grab("esc"), grab("jsq")];
  t(src.every(Boolean), "esc and jsq found in the page");
  const { jsq } = new Function(`${src.join("\n")}; return { esc, jsq };`)();
  // what the browser does to an attribute value before the handler sees it
  const decode = s => s.replace(/&(quot|#39|amp|lt|gt);/g, (_, e) => ({ quot: '"', "#39": "'", amp: "&", lt: "<", gt: ">" }[e]));
  for (const hostile of ["x');alert(1);('", 'a"b', "back\\slash", "</script><b>", "tab\tand\nnewline", "&amp; and &#39;"]) {
    const attr = jsq(hostile);
    t(!/["']/.test(attr), `attribute text holds no raw quote for ${JSON.stringify(hostile)}`);
    const handlerSource = decode(attr);
    let back;
    try { back = new Function(`return ${handlerSource};`)(); } catch { back = Symbol("syntax error"); }
    t(back === hostile, `…and the handler receives exactly ${JSON.stringify(hostile)}`);
  }
}
