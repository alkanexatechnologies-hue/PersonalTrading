// Dependency-free Markdown -> Word-openable .doc (HTML) converter.
// Word opens HTML documents saved with a .doc extension and renders headings,
// tables, lists, bold and code. Usage:
//   node scripts/md-to-doc.js <input.md> [output.doc]
"use strict";
const fs = require("fs");
const path = require("path");

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// Inline: **bold**, `code`, and escape the rest.
function inline(s) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  return out;
}

function convert(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let i = 0;
  let inList = false;
  const closeList = () => { if (inList) { html.push("</ul>"); inList = false; } };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line)) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(esc(lines[i])); i++; }
      i++; // skip closing fence
      html.push('<pre style="background:#f4f4f4;border:1px solid #ddd;padding:8px;font-family:Consolas,monospace;font-size:10pt;white-space:pre-wrap">' + buf.join("\n") + "</pre>");
      continue;
    }

    // Table: a line with | that is followed by a |---| separator
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      closeList();
      const parseRow = (l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      const headers = parseRow(line);
      i += 2; // skip header + separator
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== "") { rows.push(parseRow(lines[i])); i++; }
      let t = '<table border="1" cellspacing="0" cellpadding="5" style="border-collapse:collapse;font-size:10.5pt">';
      t += "<tr>" + headers.map((h) => '<th style="background:#2b3d5c;color:#fff;text-align:left">' + inline(h) + "</th>").join("") + "</tr>";
      for (const r of rows) t += "<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>";
      t += "</table>";
      html.push(t);
      continue;
    }

    // Headings
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const lvl = h[1].length;
      html.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      closeList();
      html.push('<blockquote style="border-left:4px solid #2b3d5c;margin:6px 0;padding:4px 12px;color:#444">' + inline(line.replace(/^>\s?/, "")) + "</blockquote>");
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) { closeList(); html.push("<hr/>"); i++; continue; }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { html.push('<ul style="margin:4px 0">'); inList = true; }
      html.push("<li>" + inline(line.replace(/^\s*[-*]\s+/, "")) + "</li>");
      i++;
      continue;
    }

    // Blank line
    if (line.trim() === "") { closeList(); i++; continue; }

    // Paragraph
    closeList();
    html.push("<p>" + inline(line) + "</p>");
    i++;
  }
  closeList();

  return `<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"/>
<style>
  body{font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#1a1a1a;line-height:1.4}
  h1{font-size:20pt;color:#1b2a44;border-bottom:2px solid #2b3d5c;padding-bottom:4px}
  h2{font-size:15pt;color:#1b2a44;margin-top:16px}
  h3{font-size:12.5pt;color:#2b3d5c}
  code{background:#eef;padding:1px 3px;font-family:Consolas,monospace;font-size:10pt}
  table{margin:8px 0}
  th,td{border:1px solid #bbb}
</style></head><body>${html.join("\n")}</body></html>`;
}

const input = process.argv[2];
if (!input) { console.error("Usage: node scripts/md-to-doc.js <input.md> [output.doc]"); process.exit(1); }
const output = process.argv[3] || input.replace(/\.md$/i, "") + ".doc";
const md = fs.readFileSync(input, "utf-8");
fs.writeFileSync(output, convert(md), "utf-8");
console.log("Wrote " + path.resolve(output));
