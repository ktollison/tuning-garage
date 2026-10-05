// Tuning Garage — Copyright (C) 2026 Kevin Tollison
// Free software under the GNU General Public License v3 or later, WITHOUT ANY
// WARRANTY. See LICENSE and NOTICE.md. Read DISCLAIMER.md before tuning.

// Escaping and Markdown rendering, shared by the app (index.html) and the print
// view (print.html), so a printed report renders exactly as it does on screen.
// Loaded as a classic script: these become globals on the page.

var esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
// A value going into an onclick="…" handler. esc() alone is not enough there:
// the browser decodes &#39; back to ' BEFORE running the handler, so a name
// containing a quote broke out of the string — a VCM Scanner file named to
// carry code would have run it. JSON makes a real JS string; esc then makes it
// safe inside the attribute, and the browser's decoding gives the JSON back.
var jsq = s => esc(JSON.stringify(String(s ?? "")));
var unesc = s => String(s).replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[e]));

// Minimal markdown renderer. Everything is HTML-escaped FIRST, then inline
// rules are applied to the already-escaped text — so a document containing
// markup renders as visible text and can never inject HTML.
function renderMarkdown(src, baseDir = "") {
  const blocks = [];
  const stash = html => `@@CODEBLOCK${blocks.push(html) - 1}@@`;

  // fenced code first, so nothing inside it gets interpreted
  let s = String(src).replace(/```[\w-]*\n([\s\S]*?)```/g, (_, code) =>
    stash(`<pre class="md">${esc(code.replace(/\n$/, ""))}</pre>`));
  s = esc(s);

  const asset = p => `/api/file?path=${encodeURIComponent((baseDir ? baseDir + "/" : "") + p.replace(/^\.\//, ""))}`;
  const inline = x => x
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) =>
      `<img src="${/^https?:/.test(src) ? src : asset(src)}" alt="${alt}" loading="lazy" class="mdimg">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, href) =>
      /^https?:/.test(href)
        ? `<a href="${href}" target="_blank" rel="noopener">${txt}</a>`
        : `<a href="#" onclick="viewDoc(${jsq((baseDir ? baseDir + "/" : "") + unesc(href).replace(/^\.\//, ""))});return false">${txt}</a>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");

  const out = [];
  let list = null, inTable = false, para = false;
  const closeList = () => { if (list) { para = false; out.push(`</${list}>`); list = null; } };
  const closeTable = () => { if (inTable) { para = false; out.push("</table>"); inTable = false; } };

  for (const raw of s.split("\n")) {
    const line = raw.trimEnd();

    if (/^@@CODEBLOCK\d+@@$/.test(line.trim())) { closeList(); closeTable(); out.push(line.trim()); continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList(); closeTable();
      const n = Math.min(h[1].length + 1, 6);
      const id = unesc(h[2]).toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
      out.push(`<h${n} id="${esc(id)}">${inline(h[2])}</h${n}>`);
      continue;
    }
    if (/^\s*(-\s*){3,}$/.test(line) || /^\s*(\*\s*){3,}$/.test(line)) {
      closeList(); closeTable(); out.push("<hr>"); continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^[\s|:\-]+$/.test(line)) continue;                     // separator row
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      if (!inTable) {
        closeList(); inTable = true;
        out.push("<table><tr>" + cells.map(c => `<th>${inline(c)}</th>`).join("") + "</tr>");
      } else {
        out.push("<tr>" + cells.map(c => `<td>${inline(c)}</td>`).join("") + "</tr>");
      }
      continue;
    }
    closeTable();

    const li = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
    if (li) {
      const want = /\d/.test(li[1]) ? "ol" : "ul";
      if (list !== want) { closeList(); list = want; out.push(`<${want}>`); }
      const body = li[2].replace(/^\[([ x])\]\s*/, (_, c) => (c === "x" ? "✅ " : "☐ "));
      out.push(`<li>${inline(body)}</li>`);
      continue;
    }
    closeList();

    if (/^\s*&gt;\s?/.test(line)) {
      const body = inline(line.replace(/^\s*&gt;\s?/, ""));
      const prev = out[out.length - 1] || "";
      // consecutive quote lines belong to one block, not one block each
      if (prev.startsWith("<blockquote>") && prev.endsWith("</blockquote>"))
        out[out.length - 1] = prev.slice(0, -13) + (body.trim() ? " " + body : "<br>") + "</blockquote>";
      else out.push(`<blockquote>${body}</blockquote>`);
      continue;
    }
    if (!line.trim()) { para = false; continue; }
    // markdown joins consecutive non-blank lines into one paragraph
    if (para && out.length && out[out.length - 1].startsWith("<p>") && out[out.length - 1].endsWith("</p>"))
      out[out.length - 1] = out[out.length - 1].slice(0, -4) + " " + inline(line) + "</p>";
    else { out.push(`<p>${inline(line)}</p>`); para = true; }
  }
  closeList(); closeTable();
  return out.join("\n").replace(/@@CODEBLOCK(\d+)@@/g, (_, i) => blocks[+i]);
}

