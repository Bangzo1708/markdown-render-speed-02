// Fast marked-18.1.3-compatible Markdown renderer (dependency-free ES module).
// Written from scratch for the make.fun markdown-render-speed-02 bounty.
// Strategy: a line-based block parser plus a sequential inline scanner whose
// emphasis/strikethrough matching mirrors marked's forward delimiter scan
// (rule of three, leftover delimiters, recursion into the inner text).

const ASCII_PUNCT = /[!-\/:-@\[-`{-~]/;
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
const WS_CHARS = ' \t\n\r\f\v   -     　﻿';

// Inline HTML tag, exactly as marked 18.1.3 tokenizes it: a comment (the
// abrupt `<!-->` / `<!--->` forms included), a closing tag with nothing but
// whitespace before `>`, an open tag whose attributes are name/value pairs
// (quoted values may hold `<` and `>`), a processing instruction, a
// declaration (name + whitespace required) or a CDATA section.
const TAG_RE = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[A-Za-z][A-Za-z0-9-]*\s*>|^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![A-Za-z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;

// Autolink `<scheme:...>` / `<email>`: the scheme needs at least two letters
// before the colon, the email has marked's shape, and neither may hold a
// space, control character or angle bracket.
const AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+(@)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;

// GFM extended autolinks. The email local part is narrower than the `<...>`
// form; the domain may hold `_`; a trailing `(?![\w-])` keeps `a.b-` literal.
const EMAIL_PROTO_RE = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)/;
const SCHEME_URL_RE = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*/;
const WWW_URL_RE = /^www\.(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*/;
const BARE_EMAIL_RE = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
// Bare-email local-part characters, as char codes (for the hand scan in
// tryUrl, which must be cheaper than running the regex at every position).
function isEmailLocal(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 43 || c === 45;
}
// Sticky (lastIndex) versions of the URL regexes, so tryUrl can match at
// `s[i]` without slicing the rest of the paragraph at every character
// (that slice was the hottest allocation in the profiler).
const sticky = (re) => new RegExp(re.source.slice(1), 'y');
const EMAIL_PROTO_Y = sticky(EMAIL_PROTO_RE);
const SCHEME_URL_Y = sticky(SCHEME_URL_RE);
const WWW_URL_Y = sticky(WWW_URL_RE);
const BARE_EMAIL_Y = sticky(BARE_EMAIL_RE);
// Sticky version of a regex that anchors every alternative with ^ (e.g.
// TAG_RE): strip those anchors — the sticky flag pins the match to
// lastIndex instead. A ^ inside a [...] class is untouched (it never
// follows the start or a | there).
const stickyAnchored = (re) => new RegExp(re.source.replace(/(^|\|)\^/g, '$1'), 'y');
const TAG_Y = stickyAnchored(TAG_RE);
const AUTOLINK_Y = stickyAnchored(AUTOLINK_RE);
// Chars that may start an email local part (the boundary rule for bare
// emails: the previous character must not be one of these).
const EMAIL_CHAR = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;
// Backpedal: trims a matched www./scheme URL the way marked does — trailing
// punctuation goes, balanced parens stay, a trailing `&name;` goes.
const BACKPEDAL_RE = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

// Next position where inline tokenizing can act: a special character, or
// the start of an extended autolink (www., a scheme:// URL, mailto:/xmpp:,
// or a bare-email local part followed by @). The inline loop bulk-appends
// plain text up to the next such position instead of dispatching per char.
const NEXT_STOP_RE = /[\\&`<![*_~\n]|www\.|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|mailto:|xmpp:|[A-Za-z0-9._+-]+@/g;

// Chars that may start an extended autolink (the tryUrl guard).
function isUrlStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '.' || ch === '_' || ch === '+' || ch === '-';
}
// Raw-HTML state: `<pre>`, `<code>`, `<kbd>` and `<script>` open a raw
// stretch (text inside is neither entity-decoded nor escaped) until the
// matching closing tag. A raw `<a ...>` tag likewise switches off extended
// autolinks until `</a>`.
const START_RAW_RE = /^<(pre|code|kbd|script)(\s|>)/i;
const END_RAW_RE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const START_A_RE = /^<a /i;
const END_A_RE = /^<\/a>/i;

function isPunct(ch) {
  return !!ch && ASCII_PUNCT.test(ch);
}
function isPunctU(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_PUNCT.test(ch);
  return UNICODE_PUNCT.test(ch);
}
function isWS(ch) {
  return !!ch && WS_CHARS.indexOf(ch) !== -1;
}

// marked's label key: trim, collapse inner whitespace to one space, then
// lower-upper-lower so that U+1E9E (ẞ) folds to "ss" like "SS" does.
function labelKey(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Escape text content: &, <, >, " and '.
function escapeHtml(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { out += s.slice(start, i) + '&amp;'; start = i + 1; }
    else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape an attribute value, leaving a valid-looking entity untouched
// (`&copy;`, `&#65;`, `&#x41;` stay as they are).
function escapeNoEncode(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      if (/^(?:[A-Za-z0-9_]+|#\d{1,7}|#[Xx][A-Fa-f0-9]{1,6});/.test(s.slice(i + 1))) continue;
      out += s.slice(start, i) + '&amp;'; start = i + 1;
    }
    else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

function encodeHref(href) {
  let e;
  try { e = encodeURI(href).replace(/%25/g, '%'); } catch { e = href; }
  return escapeNoEncode(e);
}

// Decode one numeric character reference at s[i] === '&'.
// Returns [char, length] or null. Named entities are NOT decoded here:
// they pass through unchanged (marked only decodes numeric references).
function decodeEntity(s, i) {
  if (s[i + 1] !== '#') return null;
  const semi = s.indexOf(';', i + 1);
  if (semi === -1 || semi - i > 10) return null;
  const body = s.slice(i + 2, semi);
  let cp;
  if (body.charCodeAt(0) === 120 || body.charCodeAt(0) === 88) {
    if (body.length < 2 || body.length > 7) return null;
    if (!/^[A-Fa-f0-9]+$/.test(body.slice(1))) return null;
    cp = parseInt(body.slice(1), 16);
  } else {
    if (body.length < 1 || body.length > 7) return null;
    if (!/^[0-9]+$/.test(body)) return null;
    cp = parseInt(body, 10);
  }
  if (!isFinite(cp) || cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
  return [String.fromCodePoint(cp), semi - i + 1];
}

// Paren balance of a link destination, marked's ke(): -1 when balanced (or
// no parens at all), the index of the first unbalanced `)` when the depth
// goes negative, -2 when an opening paren is never closed. Backslash
// escapes are skipped.
function parenBalance(a) {
  if (a.indexOf('(') === -1 && a.indexOf(')') === -1) return -1;
  let depth = 0;
  for (let n = 0; n < a.length; n++) {
    if (a[n] === '\\') { n++; continue; }
    if (a[n] === '(') depth++;
    else if (a[n] === ')' && (--depth < 0)) return n;
  }
  return depth > 0 ? -2 : -1;
}

// ---- link destinations and titles ----

// Parse a link destination starting at s[i] ('<' or another character).
// Returns [dest, endIdx] or null. `strictAngle` is true for inline links:
// there an unescaped `<` inside `<...>` kills the angle form (marked's
// href pattern forbids it); definitions allow it (`<.*?>`).
function parseDest(s, i, strictAngle) {
  const n = s.length;
  if (i >= n) return null;
  if (s[i] === '<') {
    let j = i + 1, out = '';
    while (j < n) {
      const ch = s[j];
      if (ch === '\n') return null;
      if (ch === '>') return [out, j + 1];
      if (strictAngle && ch === '<') return null;
      if (ch === '\\' && j + 1 < n && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      out += ch; j++;
    }
    return null;
  }
  let j = i, depth = 0, out = '';
  while (j < n) {
    const ch = s[j];
    if (ch === ' ' || ch === '\n' || ch === '\t') break;
    if (ch === '(') { depth++; out += ch; j++; continue; }
    if (ch === ')') {
      if (depth === 0) break;
      depth--; out += ch; j++; continue;
    }
    if (ch === '\\' && j + 1 < n && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    out += ch; j++;
  }
  if (j === i) return null;
  return [out, j];
}

// Parse a link title starting at s[i] (after leading spaces were skipped by
// the caller). Double-quoted titles may span lines freely; single-quoted
// ones allow a newline only when the next line is not blank; paren titles
// hold no unescaped parens. Returns [title, endIdx] or null.
function parseTitle(s, i) {
  const n = s.length;
  if (i >= n) return [null, i];
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== '(') return [null, i];
  const close = q === '(' ? ')' : q;
  let j = i + 1, out = '';
  while (j < n) {
    const ch = s[j];
    if (ch === close) return [out, j + 1];
    if (q === '(' && ch === '(') return null;
    if (ch === '\\' && j + 1 < n && isPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    if (ch === '\n') {
      if (q === "'" && s[j + 1] === '\n') return null;
      out += ch; j++; continue;
    }
    out += ch; j++;
  }
  return null;
}

// ---- links ----

const ANY_PUNCT_RE = /\\([\p{P}\p{S}])/gu;

// Remove backslash escapes before punctuation (marked's unescape step for
// link destinations and titles).
function unescapePunct(s) {
  return s.replace(ANY_PUNCT_RE, '$1');
}

// Percent-encode a link destination, escaping `&` even inside valid-looking
// entities: marked's treatment of autolink hrefs.
function encodeHrefStrict(href) {
  let e;
  try { e = encodeURI(href).replace(/%25/g, '%'); } catch { e = href; }
  return escapeHtml(e);
}

// Render one inline link / image from its label text. `labelText` is the
// raw label source; `dest` and `title` are already unescaped. Returns the
// HTML, or null when the link must not be formed (a link was already
// emitted inside its text). The label is parsed with inLink set, so
// extended autolinks stay off inside it; the link state is restored
// afterwards, except that a formed (non-image) link marks linkEmitted.
function renderLinkText(labelText, dest, title, isImg, defs, ctx) {
  const savedInLink = ctx.inLink;
  const savedEmitted = ctx.linkEmitted;
  const savedRaw = ctx.inRawBlock;
  const savedMask = ctx._mask;
  const savedMaskSrc = ctx._maskSrc;
  const savedClosers = ctx._closers;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  ctx._mask = null;
  ctx._maskSrc = null;
  ctx._closers = null;
  let inner;
  let alt = null;
  if (ctx.plain) {
    inner = inlineParse(labelText, defs, ctx);
  } else {
    inner = inlineParse(labelText, defs, ctx);
    if (isImg) {
      const savedPlain = ctx.plain;
      ctx.plain = true;
      alt = inlineParse(labelText, defs, ctx);
      ctx.plain = savedPlain;
    }
  }
  const nested = ctx.linkEmitted;
  ctx.linkEmitted = savedEmitted;
  ctx.inLink = savedInLink;
  ctx._mask = savedMask;
  ctx._maskSrc = savedMaskSrc;
  ctx._closers = savedClosers;
  // A non-image link whose label itself formed a link is rejected
  // (marked's De), in plain mode too: the alt-text re-parse must see
  // the same rejection, or [[foo](uri1)](uri2) would swallow its label.
  if (!isImg && nested) {
    ctx.inRawBlock = savedRaw;
    return null;
  }
  if (ctx.plain) {
    if (!isImg) ctx.linkEmitted = true;
    return inner;
  }
  if (!isImg) {
    ctx.linkEmitted = true;
    let out = '<a href="' + encodeHref(dest) + '"';
    if (title) out += ' title="' + escapeNoEncode(title) + '"';
    return out + '>' + inner + '</a>';
  }
  let out = '<img src="' + encodeHref(dest) + '" alt="' + escapeHtml(alt) + '"';
  if (title) out += ' title="' + escapeNoEncode(title) + '"';
  return out + '>';
}


// Skip the whitespace that may sit between a destination and a title (or
// before the closing paren): spaces/tabs, optionally one newline plus more
// spaces/tabs. A blank line is NOT allowed here. Returns the new index, or
// -1 when the character at i starts no such run (i.e. the next thing is not
// whitespace at all — then a title cannot follow).
function skipTitleSep(s, i) {
  const n = s.length;
  let j = i, saw = false;
  while (j < n && (s[j] === ' ' || s[j] === '\t')) { j++; saw = true; }
  if (j < n && s[j] === '\n') { j++; saw = true; while (j < n && (s[j] === ' ' || s[j] === '\t')) j++; }
  else if (!saw && j < n && s[j] === '\n') { j++; saw = true; while (j < n && (s[j] === ' ' || s[j] === '\t')) j++; }
  return saw ? j : -1;
}

// Try to parse a link reference definition whose first line (indent of at
// most 3 already stripped) is lines[i]. The definition may span lines for
// its label, destination and title. Returns {label, dest, title, consumed}
// (consumed = number of lines used) or null. The label keeps its backslashes
// (the lookup key folds them as written); a non-angle destination with
// unbalanced parens kills the definition (marked's def tokenizer).
function tryDef(lines, i) {
  const ind = indentOf(lines[i]);
  if (ind > 3) return null;
  const first = stripCols(lines[i], ind);
  if (first[0] !== '[') return null;
  const parts = [first];
  let k = i + 1;
  while (k < lines.length && !isBlank(lines[k]) && parts.length < 20) { parts.push(lines[k]); k++; }
  const S = parts.join('\n');
  // Label: no `[` inside, no blank line inside; backslash escapes kept.
  let pos = 1, label = '';
  while (pos < S.length) {
    const ch = S[pos];
    if (ch === '[') return null;
    if (ch === ']') break;
    if (ch === '\n') {
      // a newline inside the label is fine unless the next line is blank
      let q = pos + 1;
      while (q < S.length && (S[q] === ' ' || S[q] === '\t')) q++;
      if (S[q] === '\n' || q >= S.length) return null;
      label += ch; pos++; continue;
    }
    if (ch === '\\' && pos + 1 < S.length) { label += S[pos] + S[pos + 1]; pos += 2; continue; }
    label += ch; pos++;
  }
  if (pos >= S.length || S[pos] !== ']') return null;
  pos++;
  if (S[pos] !== ':') return null;
  pos++;
  const key = labelKey(label);
  if (!key) return null;
  // Skip spaces/tabs and at most one newline before the destination.
  while (pos < S.length && (S[pos] === ' ' || S[pos] === '\t')) pos++;
  if (S[pos] === '\n') {
    pos++;
    while (pos < S.length && (S[pos] === ' ' || S[pos] === '\t')) pos++;
  }
  const angle = S[pos] === '<';
  const destStart = pos;
  const d = parseDest(S, pos, false);
  if (!d) return null;
  const dest = d[0];
  pos = d[1];
  if (!angle && parenBalance(S.slice(destStart, pos)) !== -1) return null;
  // Optional title: same line (needs the separator) or the next line.
  let title = null;
  const sep = skipTitleSep(S, pos);
  if (sep !== -1 && sep < S.length && (S[sep] === '"' || S[sep] === "'" || S[sep] === '(')) {
    const t = parseTitle(S, sep);
    if (!t) return null;
    title = t[0];
    pos = t[1];
    while (pos < S.length && (S[pos] === ' ' || S[pos] === '\t')) pos++;
    if (pos < S.length && S[pos] !== '\n') return null;
  } else if (sep !== -1) {
    // separator consumed but no title: the rest of the line must be blank
    // (a title on the next line is handled by the joined lines: the
    // separator already crossed the newline when there was one)
    if (sep < S.length && S[sep] !== '\n') return null;
    pos = sep;
  } else if (pos < S.length && S[pos] !== '\n') {
    return null;
  }
  let consumed = 1;
  for (let m = 0; m < pos; m++) if (S[m] === '\n') consumed++;
  return { label: key, dest, title, consumed };
}

// marked's Be(): does the label hold a raw HTML tag or an autolink that
// runs past the label's end? `s` is the whole inline string, `start` the
// label's first character inside it, `label` the label text. Backslash
// escapes and code spans inside the label are skipped over.
function labelHasExtendingTag(s, start, label) {
  if (!label.includes('<')) return false;
  for (let k = 0; k < label.length; k++) {
    const ch = label[k];
    if (ch === '\\') { k++; continue; }
    if (ch === '`') {
      const span = matchCodeSpan(label, k);
      if (span) { k += span - 1; continue; }
    }
    if (ch !== '<') continue;
    TAG_Y.lastIndex = start + k;
    const tag = TAG_Y.exec(s);
    if (tag && tag[0].length > label.length - k) return true;
    AUTOLINK_Y.lastIndex = start + k;
    const auto = AUTOLINK_Y.exec(s);
    if (auto && auto[0].length > label.length - k) return true;
    if (tag) k += tag[0].length - 1;
    else if (auto) k += auto[0].length - 1;
  }
  return false;
}

// Length of the code span starting at s[i] (a backtick run), or 0 when there
// is no closing run of the same length. The span's content may hold
// backtick runs of other lengths.
function matchCodeSpan(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && s[j] === '`') j++;
  const run = j - i;
  let k = j, found = -1;
  while (k < n) {
    if (s[k] === '`') {
      let m = k;
      while (m < n && s[m] === '`') m++;
      if (m - k === run) { found = k; break; }
      k = m;
    } else k++;
  }
  if (found === -1) return 0;
  return found + run - i;
}

// Find the index just past the matching `]` for the `[` at s[i], or -1.
// Brackets nest one level; backslash escapes are skipped; a backtick run
// opens a code span whose closing run may be any length (the `]`s inside it
// do not count), and a run of two or more backticks right before `]` is
// literal text, so that `]` still closes the label.
function findCloseBracket(s, i) {
  let depth = 0;
  for (let j = i + 1; j < s.length; j++) {
    const ch = s[j];
    if (ch === '\\' && j + 1 < s.length) { j++; continue; }
    if (ch === '`') {
      let k = j;
      while (k < s.length && s[k] === '`') k++;
      if (k - j >= 2 && s[k] === ']') { if (depth === 0) return k; depth--; j = k; continue; }
      // code span: skip to just past the next backtick run (any length)
      let m = k;
      while (m < s.length && s[m] !== '`') m++;
      if (m >= s.length) return -1;
      let e = m;
      while (e < s.length && s[e] === '`') e++;
      j = e - 1;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') { if (depth === 0) return j; depth--; }
  }
  return -1;
}

// ---- inline parsing ----

// Fresh per-paragraph state: plain (render to bare text, for image alt),
// inLink (inside a link label or a raw `<a>` — extended autolinks off),
// linkEmitted (a link was just produced while parsing this text),
// inRawBlock (inside `<pre>`/`<code>`/`<kbd>`/`<script>` — no decoding).
function freshCtx(plain) {
  return { plain: !!plain, inLink: false, linkEmitted: false, inRawBlock: false };
}

function inlineParse(s, defs, ctx) {
  const n = s.length;
  let out = '';
  let buf = '';
  // trailing run of literal source spaces in buf (decoded or escaped
  // spaces do not count towards a two-space hard break)
  let trailSpaces = 0;
  const flush = () => {
    if (!buf) return;
    if (ctx.plain || ctx.inRawBlock) out += buf;
    else out += escapeHtml(buf);
    buf = '';
    trailSpaces = 0;
  };
  let i = 0;
  while (i < n) {
    const ch = s[i];
    // Fast path: when this character cannot start a token, scan ahead
    // (one native regex pass) to the next token start and bulk-append
    // the plain run instead of dispatching per character.
    if (ch !== '\\' && ch !== '&' && ch !== '`' && ch !== '<' && ch !== '!' && ch !== '[' && ch !== '*' && ch !== '_' && ch !== '~' && ch !== '\n' && !isUrlStart(ch)) {
      NEXT_STOP_RE.lastIndex = i;
      const stop = NEXT_STOP_RE.exec(s);
      const end = stop ? stop.index : n;
      if (end > i) {
        const run = s.slice(i, end);
        buf += run;
        let ts = 0;
        for (let k = run.length - 1; k >= 0 && run[k] === ' '; k--) ts++;
        trailSpaces = ts;
        i = end;
        continue;
      }
      if (!stop) break;
    }
    // Letters, digits, `.`, `+` and `-` cannot start any other token,
    // so go straight to the extended-autolink check (and the plain
    // fallback) instead of testing every token branch. `_` is excluded:
    // it is an emphasis delimiter first (see the `*`/`_` branch, which
    // also tries a bare email when emphasis fails).
    if (ch !== '_' && isUrlStart(ch)) {
      if (!ctx.inLink) {
        const url = tryUrl(s, i, ctx, buf ? buf[buf.length - 1] : '');
        if (url) {
          flush();
          out += url.html;
          i = url.end; continue;
        }
      }
      buf += ch;
      if (ch === ' ') trailSpaces++; else trailSpaces = 0;
      i++;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 < n && s[i + 1] === '\n') {
        // backslash hard break, unless only whitespace follows it
        let j = i + 2;
        while (j < n && (s[j] === ' ' || s[j] === '\t')) j++;
        if (j < n) {
          flush();
          if (!ctx.plain) out += '<br>';
          i = j; continue;
        }
        buf += '\\'; trailSpaces = 0; i++; continue;
      }
      if (i + 1 < n && isPunct(s[i + 1])) { buf += s[i + 1]; trailSpaces = 0; i += 2; continue; }
      buf += '\\'; trailSpaces = 0; i++; continue;
    }
    if (ch === '&' && !ctx.inRawBlock) {
      const d = decodeEntity(s, i);
      if (d) { buf += d[0]; trailSpaces = 0; i += d[1]; continue; }
      const semi = s.indexOf(';', i + 1);
      if (semi !== -1 && /^&[A-Za-z0-9_]+;$/.test(s.slice(i, semi + 1))) {
        flush();
        out += s.slice(i, semi + 1);
        i = semi + 1; continue;
      }
      buf += '&'; trailSpaces = 0; i++; continue;
    }
    if (ch === '`') {
      const span = matchCodeSpan(s, i);
      if (span) {
        let j = i;
        while (j < n && s[j] === '`') j++;
        const run = j - i;
        let content = s.slice(j, i + span - run).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') content = content.slice(1, -1);
        flush();
        if (ctx.plain) out += content;
        else out += '<code>' + escapeHtml(content) + '</code>';
        i += span; continue;
      }
      // No closing run of the same length: the whole run is literal
      // text (marked's text token starts with `+, so a failed run is
      // never retried mid-run — e.g. ```foo`` stays literal).
      let runLen = 0;
      while (i + runLen < n && s[i + runLen] === '`') runLen++;
      buf += s.slice(i, i + runLen);
      trailSpaces = 0; i += runLen; continue;
    }
    if (ch === '<') {
      TAG_Y.lastIndex = i;
      const tag = TAG_Y.exec(s);
      if (tag) {
        flush();
        if (!ctx.inRawBlock && START_RAW_RE.test(tag[0])) ctx.inRawBlock = true;
        else if (ctx.inRawBlock && END_RAW_RE.test(tag[0])) ctx.inRawBlock = false;
        if (START_A_RE.test(tag[0])) ctx.inLink = true;
        else if (END_A_RE.test(tag[0])) ctx.inLink = false;
        out += tag[0];
        i += tag[0].length; continue;
      }
      AUTOLINK_Y.lastIndex = i;
      const auto = AUTOLINK_Y.exec(s);
      if (auto) {
        const inner = auto[1];
        flush();
        if (ctx.plain) out += inner;
        else {
          const href = auto[2] === '@' ? 'mailto:' + inner : inner;
          out += '<a href="' + encodeHrefStrict(href) + '">' + escapeHtml(inner) + '</a>';
        }
        i += auto[0].length; continue;
      }
      buf += '<'; trailSpaces = 0; i++; continue;
    }
    if (ch === '!' || ch === '[') {
      const isImg = ch === '!';
      const start = isImg ? i + 1 : i;
      if (isImg && s[start] !== '[') { buf += '!'; trailSpaces = 0; i++; continue; }
      const link = tryLink(s, start, defs, isImg, ctx);
      if (link) {
        flush();
        out += link.html;
        i = link.end; continue;
      }
      buf += ch; trailSpaces = 0; i++; continue;
    }
    if (ch === '*' || ch === '_') {
      let runLen = 0;
      while (i + runLen < n && s[i + runLen] === ch) runLen++;
      const prevChar = buf ? buf[buf.length - 1] : '';
      const em = tryEmphasis(s, i, runLen, defs, ctx, prevChar);
      if (em) {
        flush();
        const savedMask = ctx._mask, savedMaskSrc = ctx._maskSrc, savedClosers = ctx._closers;
        ctx._mask = null; ctx._maskSrc = null; ctx._closers = null;
        const inner = inlineParse(em.inner, defs, ctx);
        ctx._mask = savedMask; ctx._maskSrc = savedMaskSrc; ctx._closers = savedClosers;
        out += ctx.plain ? inner : em.strong ? `<strong>${inner}</strong>` : `<em>${inner}</em>`;
        i += em.raw.length; continue;
      }
      // no emphasis here: a `_` can still start a bare email
      // (`_b@c.d` links the whole run in marked — `_` is an
      // email-local character). `*` cannot start an email or a URL.
      if (ch === '_' && !ctx.inLink) {
        const url = tryUrl(s, i, ctx, buf ? buf[buf.length - 1] : '');
        if (url) {
          flush();
          out += url.html;
          i = url.end; continue;
        }
      }
      // no match here: consume one delimiter and retry inside the run
      buf += ch; trailSpaces = 0; i++; continue;
    }
    if (ch === '~') {
      let runLen = 0;
      while (i + runLen < n && s[i + runLen] === ch) runLen++;
      const prevChar = buf ? buf[buf.length - 1] : '';
      const del = tryDel(s, i, runLen, defs, ctx, prevChar);
      if (del) {
        flush();
        const savedMask = ctx._mask, savedMaskSrc = ctx._maskSrc, savedClosers = ctx._closers;
        ctx._mask = null; ctx._maskSrc = null; ctx._closers = null;
        const inner = inlineParse(del.inner, defs, ctx);
        ctx._mask = savedMask; ctx._maskSrc = savedMaskSrc; ctx._closers = savedClosers;
        out += ctx.plain ? inner : `<del>${inner}</del>`;
        i += del.raw.length; continue;
      }
      // no match: a `~` run is swallowed whole (marked's text token
      // starts with `~+`, so a failed run is never retried mid-run)
      buf += s.slice(i, i + runLen);
      trailSpaces = 0;
      i += runLen; continue;
    }
    if (ch === '\n') {
      if (trailSpaces >= 2) {
        let j = i + 1;
        while (j < n && (s[j] === ' ' || s[j] === '\t')) j++;
        if (j < n) {
          buf = buf.slice(0, -trailSpaces);
          trailSpaces = 0;
          flush();
          if (!ctx.plain) out += '<br>';
          i = j; continue;
        }
      }
      buf += '\n'; trailSpaces = 0; i++; continue;
    }
    // Extended autolinks can only start at a letter or an email-local
    // character (mailto:/xmpp: need m/x, schemes h/f, www. needs w, a
    // bare email needs [A-Za-z0-9._+-]); anything else cannot match.
    if (!ctx.inLink && isUrlStart(ch)) {
      const url = tryUrl(s, i, ctx, buf ? buf[buf.length - 1] : '');
      if (url) {
        flush();
        out += url.html;
        i = url.end; continue;
      }
    }
    buf += ch;
    if (ch === ' ') trailSpaces++; else trailSpaces = 0;
    i++;
  }
  flush();
  return out;
}

// ---- small shared helpers (block parser, link handling) ----

// Strip every trailing copy of `ch` from the end of `s`.
function stripEnd(s, ch) {
  let i = s.length;
  while (i > 0 && s[i - 1] === ch) i--;
  return s.slice(0, i);
}

// Expand tabs to spaces with tab stops of 4, tracking the column.
function expandTabs(s, startCol = 0) {
  let col = startCol;
  let out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Unicode whitespace (CommonMark's set, plus the extra spaces marked uses).
function isSpaceU(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 ||
    WS_CHARS.indexOf(ch) !== -1;
}

// Leading indent of a line, in columns (a tab advances to the next multiple
// of 4).
function indentOf(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Remove `n` columns of leading indent from a line. A tab that straddles
// the cut leaves its remainder behind as spaces.
function stripCols(line, n) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; }
      else return ' '.repeat(col + w - n) + line.slice(i + 1);
    } else break;
  }
  return line.slice(i);
}

function isBlank(line) {
  return /^[ \t]*$/.test(line);
}

// ---- emphasis / strikethrough machinery ----
//
// The closer search mirrors marked's delimiter algorithm: before scanning,
// the source is "masked" — link labels, code spans, tags and escaped
// punctuation are replaced by same-length filler so delimiters inside them
// cannot act as closers — and the last possible closer position for each
// delimiter is precomputed by one scan.

const PUNCT_TILDE = '(?!~)[\\p{P}\\p{S}]';
const PUNCT_SPACE_TILDE = '(?!~)[\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE_TILDE = '(?:[^\\s\\p{P}\\p{S}]|~)';
const PUNCT_RE = '[\\p{P}\\p{S}]';
const PUNCT_SPACE_RE = '[\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE_RE = '[^\\s\\p{P}\\p{S}]';

// Delimiter runs that may open emphasis / strong emphasis (GFM flavour:
// `~` does not count as punctuation here).
const EM_L_DELIM = new RegExp(
  `^(?:\\*+(?:((?!\\*)${PUNCT_TILDE})|([^\\s*]))?)|^_+(?:((?!_)${PUNCT_TILDE})|([^\\s_]))?`, 'u');
// Runs that may close emphasis / strong emphasis (asterisk flavour).
const EM_R_AST = new RegExp(
  `^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)${PUNCT_TILDE}(\\*+)(?=[\\s]|$)|${NOT_PUNCT_SPACE_TILDE}(\\*+)(?!\\*)(?=${PUNCT_SPACE_TILDE}|$)|(?!\\*)${PUNCT_SPACE_TILDE}(\\*+)(?=${NOT_PUNCT_SPACE_TILDE})|[\\s](\\*+)(?!\\*)(?=${PUNCT_TILDE})|(?!\\*)${PUNCT_TILDE}(\\*+)(?!\\*)(?=${PUNCT_TILDE})|${NOT_PUNCT_SPACE_TILDE}(\\*+)(?=${NOT_PUNCT_SPACE_TILDE})`, 'gu');
// Runs that may close emphasis / strong emphasis (underscore flavour: no
// closer flanked by non-punctuation on both sides, so intra-word
// underscores never close).
const EM_R_UND = new RegExp(
  `^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)${PUNCT_RE}(_+)(?=[\\s]|$)|${NOT_PUNCT_SPACE_RE}(_+)(?!_)(?=${PUNCT_SPACE_RE}|$)|(?!_)${PUNCT_SPACE_RE}(_+)(?=${NOT_PUNCT_SPACE_RE})|[\\s](_+)(?!_)(?=${PUNCT_RE})|(?!_)${PUNCT_RE}(_+)(?!_)(?=${PUNCT_RE})`, 'gu');
// Strikethrough delimiters.
const DEL_L_DELIM = new RegExp(`^~~?(?:((?!~)${PUNCT_RE})|[^\\s~])`, 'u');
const DEL_R_DELIM = new RegExp(
  `^[^~]+(?=[^~])|(?!~)${PUNCT_RE}(~~?)(?=[\\s]|$)|${NOT_PUNCT_SPACE_RE}(~~?)(?!~)(?=${PUNCT_SPACE_RE}|$)|(?!~)${PUNCT_SPACE_RE}(~~?)(?=${NOT_PUNCT_SPACE_RE})|[\\s](~~?)(?!~)(?=${PUNCT_RE})|(?!~)${PUNCT_RE}(~~?)(?!~)(?=${PUNCT_RE})|${NOT_PUNCT_SPACE_RE}(~~?)(?=${NOT_PUNCT_SPACE_RE})`, 'gu');
const PUNCT_OR_SPACE = new RegExp(`^((?![*_])[\\s\\p{P}\\p{S}])`, 'u');
const UNICODE_ALNUM = /[\p{L}\p{N}]/u;

// Pieces for the masking patterns below.
const MASK_BRACKETED = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const MASK_LABEL_LOOSE =
  `(?:[^\\[\\]\\\\\`]*(?:\\[(?:${MASK_BRACKETED}|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|\`+(?!\`)[^\`]*?\`+(?!\`)|\\\`\\\`+(?=\\]))){0,999}?[^\\[\\]\\\\\`]*?`;
const MASK_REF_LOOSE = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
// Reference links, used to mask link-like text before emphasis scanning.
const HAS_NON_WS = /\S/;
const REFLINK_SEARCH = new RegExp(
  `!?\\[${MASK_LABEL_LOOSE}\\]\\[${MASK_REF_LOOSE}\\]|!?\\[${MASK_REF_LOOSE}\\](?:\\[\\])?(?!\\()`, 'g');
// Inline links, code spans and tags, masked out before emphasis scanning.
const BLOCK_SKIP = new RegExp(
  `\\[(?:[^\\[\\]\`]|(?<a>\`+)[^\`]+\\k<a>(?!\`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!\`)()(?<b>\`+)[^\`]+\\k<b>(?!\`)|<(?! )[^<>]*?>`, 'g');
// Escaped punctuation (masked) and code spans (backticks inside neutralised).
const ANY_PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
// Inline link shape, only used to test whether a masked span hides a link.
const LINK_TEST = new RegExp(
  `^!?\\[(?:\\[(?:${MASK_BRACKETED}|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|\`+(?!\`)[^\`]*?\`+(?!\`)|\\\`\\\`+(?=\\])|[^\\[\\]\\\\\`])*?\\]\\([ \\t\\n]*(?:<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)`);

// Does `text` contain a link (inline or reference) that marked would accept?
// Used while masking, to decide whether a [..][..] span hides its label.
function linkInText(text, links) {
  if (!text.includes('[')) return false;
  BLOCK_SKIP.lastIndex = 0;
  for (const m of text.matchAll(BLOCK_SKIP)) {
    if (LINK_TEST.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  REFLINK_SEARCH.lastIndex = 0;
  for (const m of text.matchAll(REFLINK_SEARCH)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (
      !(s.charAt(0) === '!' || !Object.hasOwn(links, labelKey(s.slice(r + 1, -1)))) &&
      !(r > 1 && linkInText(s.slice(1, r - 1), links))
    ) {
      return true;
    }
  }
  return false;
}

// Build the masked source for emphasis scanning: same length as `src`, with
// the insides of reference links, code spans, inline links and tags, and
// escaped punctuation neutralised.
function maskSource(src, links) {
  let t = src;
  if (links && src.includes('[')) {
    REFLINK_SEARCH.lastIndex = 0;
    const maskReflink = (whole) => {
      const o = whole.lastIndexOf('[');
      if (!Object.hasOwn(links, labelKey(whole.slice(o + 1, -1)))) return whole;
      if (o > 1 && whole.charAt(0) !== '!') {
        const inner = whole.slice(1, o - 1);
        if (linkInText(inner, links)) {
          return '[' + inner.replace(REFLINK_SEARCH, maskReflink) + '][' + 'a'.repeat(whole.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(whole.length - 2) + ']';
    };
    t = t.replace(REFLINK_SEARCH, maskReflink);
  }
  // Each replace below is a no-op unless its trigger characters occur;
  // skipping the full-paragraph scan when they do not is worth several
  // percent on emphasis-heavy documents.
  if (src.includes('`') || src.includes('\\')) {
    t = t.replace(ANY_PUNCT_OUTSIDE_CODE, (whole, ticks, punct) =>
      punct ? '+'.repeat(whole.length) : ticks ? ticks + whole.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks : whole
    );
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    t = t.replace(BLOCK_SKIP, (whole, pre) => {
      const o = pre ? pre.length : 0;
      return whole.slice(0, o) + '[' + 'a'.repeat(whole.length - o - 2) + ']';
    });
  }
  return t;
}

// Scan `src` once for the last index at which a `*`, `_` or `~` run could
// close emphasis / strikethrough: the run's first character, provided the
// character before it is not whitespace.
function lastCloserPositions(src) {
  let star = -1;
  let under = -1;
  let tilde = -1;
  const n = src.length;
  for (let s = 0; s < n; s++) {
    const ch = src[s];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = s === 0 ? '\n' : src[s - 1];
    let i = s + 1;
    while (i < n && src[i] === ch) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') tilde = s;
      else if (ch === '*') star = s;
      else under = s;
    }
    s = i - 1;
  }
  return { star, under, tilde };
}

// Lazily compute (and cache on the context) the masked source and closer
// positions for `s`. The cache is saved and restored around recursive
// inline parses, so an inner parse never clobbers the outer scan.
function maskFor(s, defs, ctx) {
  if (!ctx._mask || ctx._maskSrc !== s) {
    ctx._maskSrc = s;
    ctx._mask = maskSource(s, defs);
    ctx._closers = lastCloserPositions(ctx._mask);
  }
  return ctx._mask;
}

// Try to match an emphasis / strong emphasis opener: a run of `*` or `_`
// starting at `s[start]` (`runLen` long), with `prevChar` the previous
// emitted text character ("" when the previous token was not plain text).
// Returns {raw, inner, strong} or null. Mirrors marked's forward delimiter
// scan: opener-only runs add to the open count, both-flanking runs are
// subject to the rule of three, and the first run that brings the count to
// zero closes (one delimiter for <em>, two for <strong>).
function tryEmphasis(s, start, runLen, defs, ctx, prevChar) {
  const src = s.slice(start);
  const m = EM_L_DELIM.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const masked = maskFor(s, defs, ctx);
  const closers = ctx._closers;
  const delim = m[0][0];
  const sameAsPrev = prevChar === delim;
  const i = start;
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  const prev = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const prevDelimOrPunct = prev === '*' || prev === '_' || PUNCT_OR_SPACE.test(prev);
  if (l < i) prevChar = prev;
  const nextIsPunct = l < i ? prevDelimOrPunct : PUNCT_OR_SPACE.test(prevChar);
  if (m[4] && UNICODE_ALNUM.test(prevChar)) return null;
  const afterPunct = m[1] || m[3] || '';
  if (!afterPunct || !prevChar || nextIsPunct) {
    const run = [...m[0]].length - 1;
    let open = run;
    let extra = 0;
    const y = i - l + run;
    const ruleOfThree = !!prev.trim() && (!!afterPunct || (delim === '*' && !prevDelimOrPunct));
    if (delim !== '*' && delim !== '_') return null;
    const rdelim = delim === '*' ? EM_R_AST : EM_R_UND;
    const last = delim === '*' ? closers.star : closers.under;
    const q = i + run;
    if (last < q) return null;
    const rest = masked.slice(q);
    const limit = last - q;
    rdelim.lastIndex = 0;
    let c;
    while ((c = rdelim.exec(rest)) !== null && !(c.index > limit)) {
      const g = c[1] || c[2] || c[3] || c[4] || c[5] || c[6];
      if (!g) continue;
      const b0 = [...g].length;
      if (c[3] || c[4]) {
        open += b0;
        continue;
      } else if (c[5] || c[6] || ruleOfThree) {
        if (sameAsPrev && (c[5] || c[6])) break;
        if (y % 3 && !((y + b0) % 3)) {
          extra += b0;
          continue;
        }
      }
      open -= b0;
      if (open > 0) continue;
      const b = Math.min(b0, b0 + open + extra);
      const lead = [...c[0]][0].length;
      const raw = src.slice(0, run + c.index + lead + b);
      if (Math.min(run, b) % 2) {
        return { raw, inner: raw.slice(1, -1), strong: false };
      }
      return { raw, inner: raw.slice(2, -2), strong: true };
    }
  }
  return null;
}

// Try to match a strikethrough opener: one or two `~` at `s[start]`
// (`runLen` long). Returns {raw, inner} or null. The opener is at most
// two tildes; the closer must have exactly the same length.
function tryDel(s, start, runLen, defs, ctx, prevChar) {
  const src = s.slice(start);
  const m = DEL_L_DELIM.exec(src);
  if (!m) return null;
  if (!(m[1] || '') || !prevChar || PUNCT_OR_SPACE.test(prevChar)) {
    const masked = maskFor(s, defs, ctx);
    const closers = ctx._closers;
    const run = [...m[0]].length - 1;
    let open = run;
    const rdelim = DEL_R_DELIM;
    const d = start + run;
    if (closers.tilde < d) return null;
    const rest = masked.slice(d);
    const limit = closers.tilde - d;
    rdelim.lastIndex = 0;
    let c;
    while ((c = rdelim.exec(rest)) !== null && !(c.index > limit)) {
      const g = c[1] || c[2] || c[3] || c[4] || c[5] || c[6];
      if (!g) continue;
      let len = [...g].length;
      if (len !== run) continue;
      if (c[3] || c[4]) {
        open += len;
        continue;
      }
      open -= len;
      if (open > 0) continue;
      len = Math.min(len, len + open);
      const lead = [...c[0]][0].length;
      const raw = src.slice(0, run + c.index + lead + len);
      return { raw, inner: raw.slice(run, -run) };
    }
  }
  return null;
}

// Try to match a link (or image, when `isImg`) whose `[` is at `s[start]`.
// Returns {html, end} or null. Handles inline links, full / collapsed /
// shortcut reference links. A non-angle destination is scanned raw (all
// non-space characters) and then cut at the first unbalanced `)`, which
// becomes the link's closing paren — the way marked's backtracking regex
// behaves; the paren balance is judged on the raw text, so escaped parens
// do not count.
function tryLink(s, start, defs, isImg, ctx) {
  const n = s.length;
  const close = findCloseBracket(s, start);
  if (close === -1) return null;
  const label = s.slice(start + 1, close);
  if (labelHasExtendingTag(s, start + 1, label)) return null;
  const j = close + 1;
  let dest = null;
  let title = null;
  let endIdx = -1;
  // Inline destination after `](`: returns [dest, title, endIdx] or
  // null when the `(...)` is not a valid inline link. A failure here
  // does NOT kill the link outright — marked then tries the shortcut
  // reference form `[label]` (cm-568: `[foo](not a link)` with a
  // `[foo]: /url1` definition links to /url1).
  const inlineDest = () => {
    let k = j + 1;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (k < n && s[k] === ')') return ['', '', k + 1];
    let d, t = null, pos;
    if (k < n && s[k] === '<') {
      d = parseDest(s, k, true);
      if (!d) return null;
      pos = d[1];
      const sep = skipTitleSep(s, pos);
      if (sep !== -1 && sep < n && (s[sep] === '"' || s[sep] === "'" || s[sep] === '(')) {
        const tt = parseTitle(s, sep);
        if (!tt) return null;
        t = tt[0];
        pos = tt[1];
      }
      while (pos < n && (s[pos] === ' ' || s[pos] === '\t' || s[pos] === '\n')) pos++;
      if (pos >= n || s[pos] !== ')') return null;
      return [d[0], t, pos + 1];
    }
    let e = k;
    while (e < n && s.charCodeAt(e) > 32) e++;
    if (e === k) return null;
    let rawDest = s.slice(k, e);
    const pb = parenBalance(rawDest);
    if (pb === -2) return null;
    if (pb > -1) {
      rawDest = rawDest.slice(0, pb);
      return [unescapePunct(rawDest), '', k + pb + 1];
    }
    pos = e;
    const sep = skipTitleSep(s, pos);
    if (sep !== -1 && sep < n && (s[sep] === '"' || s[sep] === "'" || s[sep] === '(')) {
      const tt = parseTitle(s, sep);
      if (!tt) return null;
      t = tt[0];
      pos = tt[1];
    }
    while (pos < n && (s[pos] === ' ' || s[pos] === '\t' || s[pos] === '\n')) pos++;
    if (pos >= n || s[pos] !== ')') return null;
    return [unescapePunct(rawDest), t, pos + 1];
  };
  if (j < n && s[j] === '(') {
    const il = inlineDest();
    if (il) {
      dest = il[0];
      title = il[1];
      endIdx = il[2];
      // The closing paren must not be escaped: an odd run of
      // backslashes right before it invalidates the link.
      const rawWhole = s.slice(isImg ? start - 1 : start, endIdx);
      const stripped = stripEnd(rawWhole.slice(0, -1), '\\');
      if ((rawWhole.length - stripped.length) % 2 === 0) { dest = null; endIdx = -1; }
    }
  }
  if (endIdx === -1) {
  if (j < n && s[j] === '[') {
    // Reference label: no `[` inside, no blank line inside, at most 999
    // characters, not all whitespace.
    let k = j + 1;
    let ref = null;
    let refEnd = -1;
    while (k < n) {
      const ch = s[k];
      if (ch === '\\' && k + 1 < n) { k += 2; continue; }
      if (ch === ']') { ref = s.slice(j + 1, k); refEnd = k + 1; break; }
      if (ch === '[') break;
      if (ch === '\n') {
        let q = k + 1;
        while (q < n && (s[q] === ' ' || s[q] === '\t')) q++;
        if (q >= n || s[q] === '\n') break;
      }
      if (k - j > 999) break;
      k++;
    }
    let key = null;
    if (ref !== null && ref.trim() !== '') key = labelKey(ref);
    else if (ref === '') key = labelKey(label);
    if (key === null) {
      // Not a reference link: fall back to the shortcut form.
      const def = defs[labelKey(label)];
      if (!def) return null;
      dest = def.href;
      title = def.title;
      endIdx = j;
    } else {
      const def = defs[key];
      if (!def) return null;
      dest = def.href;
      title = def.title;
      endIdx = refEnd;
    }
  } else {
    const def = defs[labelKey(label)];
    if (!def) return null;
    dest = def.href;
    title = def.title;
    endIdx = j;
  }
  }
  const html = renderLinkText(label, dest, title || '', isImg, defs, ctx);
  if (html === null) return null;
  return { html, end: endIdx };
}

// ---- block-level patterns (marked's shapes) ----

// Tiny template helper (the same idea as marked's): substitutes named
// placeholders in a regex and returns a fresh regex.
function edit(re, flags = '') {
  let src = typeof re === 'string' ? re : re.source;
  const api = {
    replace(name, val) {
      const v = typeof val === 'string' ? val : val.source;
      src = src.replace(name, v.replace(/(^|[^[])\^/g, '$1'));
      return api;
    },
    getRegex() {
      return new RegExp(src, flags);
    },
  };
  return api;
}

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const BLOCK = (() => {
  const newline = /^(?:[ \t]*(?:\n|$))+/;
  const indentCode = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
  const fences =
    /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
  const hr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
  const heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
  const bullet = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
  // Setext heading: a paragraph-like run of lines followed by = or -.
  const lheadingSrc =
    /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
  const lheading = edit(lheadingSrc)
    .replace(/bull/g, bullet)
    .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
    .replace(/blockquote/g, / {0,3}>/)
    .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
    .replace(/hr/g, /(?: {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$))/)
    .replace(/html/g, / {0,3}<[^\n>]+>\n/)
    .replace(/\|table/g, '')
    .getRegex();
  const lheadingGfm = edit(lheadingSrc)
    .replace(/bull/g, bullet)
    .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
    .replace(/blockquote/g, / {0,3}>/)
    .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
    .replace(/hr/g, /(?: {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$))/)
    .replace(/html/g, / {0,3}<[^\n>]+>\n/)
    .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[:\- ]*\n/)
    .getRegex();
  // Paragraph: lines that are not the start of some other block.
  const paraSrc = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
  const para = (listRe, tableRe) => {
    const e = edit(paraSrc)
      .replace('hr', hr)
      .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
      .replace('|lheading', '');
    if (tableRe) e.replace('table', tableRe);
    else e.replace('|table', '');
    return e
      .replace('blockquote', ' {0,3}>')
      .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
      .replace('list', listRe)
      .replace('html', ` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`)
      .getRegex();
  };
  const text = /^[^\n]+/;
  // Link reference definition: [label]: <dest> "title"
  const labelInner = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
  const def = edit(
    /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/
  )
    .replace('label', labelInner)
    .replace(
      'title',
      /(?:\"(?:\\[\s\S]|[^\"\\])*\"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/
    )
    .getRegex();
  const listStart = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, bullet).getRegex();
  const htmlComment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
  const htmlBlock = edit(
    "^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))",
    'i'
  )
    .replace('comment', htmlComment)
    .replace('tag', BLOCK_TAGS)
    .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *\"[^\"\n]*\"| *= *'[^'\n]*'| *= *[^\s\"'=<>`]+)?/)
    .getRegex();
  const blockquote = edit(
    /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/
  )
    .replace('paragraph', para(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/))
    .getRegex();
  const table = edit(
    "^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)"
  )
    .replace('hr', hr)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('blockquote', ' {0,3}>')
    .replace('code', /(?: {4}| {0,3}\t)[^\n]/)
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
    .replace('html', ` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`)
    .getRegex();
  return {
    newline, indentCode, fences, hr, heading, lheading, lheadingGfm, para, text,
    def, listStart, htmlBlock, blockquote, table,
  };
})();

// Per-indent cached regexes (marked caches these by indent level 0..3).
const cached = (() => {
  const cache = (fn) => {
    const arr = [];
    return (n) => {
      const i = Math.max(0, Math.min(3, n - 1));
      return arr[i] || (arr[i] = fn(i));
    };
  };
  return {
    nextBullet: cache((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`)),
    hr: cache((n) => new RegExp(`^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`)),
    fencesBegin: cache((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`)),
    headingBegin: cache((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`)),
    htmlBegin: cache(
      (n) =>
        new RegExp(
          `^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
          'i'
        )
    ),
    blockquoteBegin: cache((n) => new RegExp(`^ {0,${n}}>`)),
  };
})();

function listItemRegex(bullet) {
  return new RegExp(`^( {0,3}${bullet})((?:[ \\t][^\\n]*)?(?:\\n|$))`);
}

// ---- block parser ----------------------------------------------------------
//
// blockParse(src, links, top, inBlock) returns an array of block nodes.
// Node shapes (only what the renderer needs):
//   {type:'space', raw} {type:'code', raw, text, lang?}
//   {type:'heading', raw, depth, text} {type:'hr', raw}
//   {type:'html', raw, text, pre} {type:'def', raw} (renders nothing)
//   {type:'paragraph', raw, text} {type:'text', raw, text}
//   {type:'table', raw, header:[{text,align}], align:[], rows:[[{text,align}]]}
//   {type:'blockquote', raw, text, children:[]}
//   {type:'list', raw, ordered, start, loose, items:[{raw,text,task,checked,loose,children:[]}]}
//
// Inline rendering is deferred: paragraph / heading / table cell / text
// nodes keep their raw `text`, rendered later with the final link map.

const CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const BLANK_LINE_RE = /^[ \t]*$/;
const DOUBLE_BLANK_RE = /\n[ \t]*\n[ \t]*$/;
const BQ_START_RE = /^ {0,3}>/;
const BQ_SETEXT_RE = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BQ_SETEXT2_RE = /^ {0,3}>[ \t]?/gm;
const BQ_MARKER_WS_RE = /^( {0,3}>)([ \t]+)/gm;
const LIST_IS_TASK_RE = /^\[[ xX]\][ \t]+\S/;
const LIST_REPLACE_TASK_RE = /^\[[ xX]\][ \t]+/;
const LIST_TASK_CB_RE = /\[[ xX]\]/;
const ANY_LINE_RE = /\n.*\n/;
const TABLE_DELIM_RE = /[:|]/;
const TABLE_ALIGN_CHARS_RE = /^\||\| *$/g;
const TABLE_ROW_BLANK_RE = /\n[ \t]*$/;
const TABLE_ALIGN_RIGHT_RE = /^ *-+: *$/;
const TABLE_ALIGN_CENTER_RE = /^ *:-+: *$/;
const TABLE_ALIGN_LEFT_RE = /^ *:-+ *$/;
const INDENT_CODE_COMP_RE = /^(\s+)(?:```)/;
const ENDING_HASH_RE = /#$/;
const ENDING_SPACE_TAB_RE = /[ \t]$/;
const NOT_SPACE_START_RE = /^\S*/;
const ENDING_NEWLINE_RE = /\n$/;

// Remove trailing blank lines from the end of an indented code block (at
// most one blank line is kept).
function trimCodeEnd(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && BLANK_LINE_RE.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Split a table row on unescaped pipes, trimming cells and unescaping \|.
function splitRow(row, count) {
  const t = row.replace(/\|/g, (ch, off, str) => {
    let escaped = false;
    let p = off;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(/ \|/);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

const paraMain = BLOCK.para(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/, BLOCK.table);
const paraBq = BLOCK.para(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/, null);

function blockParse(src, links, top, inBlock, out) {
  const nodes = out || [];
  let rest = src;
  let guard = Infinity;
  while (rest) {
    if (rest.length < guard) guard = rest.length;
    else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    let m;
    // Blank lines.
    if ((m = BLOCK.newline.exec(rest))) {
      rest = rest.slice(m[0].length);
      const last = nodes[nodes.length - 1];
      if (m[0].length === 1 && last) last.raw += '\n';
      else nodes.push({ type: 'space', raw: m[0] });
      continue;
    }
    // Indented code block.
    if ((m = BLOCK.indentCode.exec(rest))) {
      const raw = trimCodeEnd(m[0]);
      const text = raw.replace(CODE_REMOVE_INDENT, '');
      rest = rest.slice(raw.length);
      const last = nodes[nodes.length - 1];
      if (last && (last.type === 'paragraph' || last.type === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
        last.text += '\n' + text;
      } else {
        nodes.push({ type: 'code', raw, text });
      }
      continue;
    }
    // Fenced code block.
    if ((m = BLOCK.fences.exec(rest))) {
      const raw = m[0];
      let text = m[3] || '';
      const fenceIndent = raw.match(INDENT_CODE_COMP_RE);
      if (fenceIndent) {
        const ind = fenceIndent[1];
        text = text
          .split('\n')
          .map((line) => {
            const lead = line.match(/^\s+/);
            if (!lead) return line;
            return line.slice(Math.min(lead[0].length, ind.length));
          })
          .join('\n');
      }
      const lang = m[2] ? m[2].trim().replace(ANY_PUNCT_RE, '$1') : m[2];
      rest = rest.slice(raw.length);
      nodes.push({ type: 'code', raw, text, lang });
      continue;
    }
    // ATX heading.
    if ((m = BLOCK.heading.exec(rest))) {
      let text = m[2].trim();
      if (ENDING_HASH_RE.test(text)) {
        const stripped = stripEnd(text, '#');
        if (!stripped || ENDING_SPACE_TAB_RE.test(stripped)) text = stripped.trim();
      }
      const headingRaw = stripEnd(m[0], '\n');
      rest = rest.slice(headingRaw.length);
      nodes.push({ type: 'heading', raw: headingRaw, depth: m[1].length, text });
      continue;
    }
    // Thematic break.
    if ((m = BLOCK.hr.exec(rest))) {
      rest = rest.slice(stripEnd(m[0], '\n').length);
      nodes.push({ type: 'hr', raw: stripEnd(m[0], '\n') });
      continue;
    }
    // Block quote.
    if ((m = BLOCK.blockquote.exec(rest))) {
      const node = parseBlockquote(m[0], links);
      rest = rest.slice(node.raw.length);
      nodes.push(node);
      continue;
    }
    // List.
    if ((m = BLOCK.listStart.exec(rest))) {
      const node = parseList(rest, links);
      if (node) {
        rest = rest.slice(node.raw.length);
        nodes.push(node);
        continue;
      }
    }
    // Raw HTML block.
    if ((m = BLOCK.htmlBlock.exec(rest))) {
      const text = trimCodeEnd(m[0]);
      rest = rest.slice(text.length);
      nodes.push({ type: 'html', raw: text, text, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style' });
      continue;
    }
    // Link reference definition.
    if ((m = BLOCK.def.exec(rest))) {
      if (m[2][0] === '<' || parenBalance(m[2]) === -1) {
        const tag = labelKey(m[1]);
        let href = m[2];
        if (href[0] === '<') href = href.slice(1, -1);
        href = unescapePunct(href);
        const title = m[3] ? unescapePunct(m[3].substring(1, m[3].length - 1)) : m[3];
        const raw = stripEnd(m[0], '\n');
        rest = rest.slice(raw.length);
        const last = nodes[nodes.length - 1];
        if (last && (last.type === 'paragraph' || last.type === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
          last.text += '\n' + raw;
        } else {
          if (!Object.hasOwn(links, tag)) links[tag] = { href, title };
          nodes.push({ type: 'def', raw });
        }
        continue;
      }
    }
    // Table.
    if ((m = BLOCK.table.exec(rest))) {
      if (TABLE_DELIM_RE.test(m[2])) {
        const head = splitRow(m[1]);
        const aligns = m[2].replace(TABLE_ALIGN_CHARS_RE, '').split('|');
        if (head.length === aligns.length) {
          const align = [];
          for (const a of aligns) {
            if (TABLE_ALIGN_RIGHT_RE.test(a)) align.push('right');
            else if (TABLE_ALIGN_CENTER_RE.test(a)) align.push('center');
            else if (TABLE_ALIGN_LEFT_RE.test(a)) align.push('left');
            else align.push(null);
          }
          const header = head.map((t, i) => ({ text: t, header: true, align: align[i] }));
          const rows = [];
          if (m[3] && m[3].trim()) {
            for (const line of m[3].replace(TABLE_ROW_BLANK_RE, '').split('\n')) {
              rows.push(splitRow(line, header.length).map((t, i) => ({ text: t, align: align[i] })));
            }
          }
          const tableRaw = stripEnd(m[0], '\n');
          rest = rest.slice(tableRaw.length);
          nodes.push({ type: 'table', raw: tableRaw, header, align, rows });
          continue;
        }
      }
    }
    // Setext heading.
    if ((m = BLOCK.lheadingGfm.exec(rest))) {
      const lhRaw = stripEnd(m[0], '\n');
      rest = rest.slice(lhRaw.length);
      nodes.push({ type: 'heading', raw: lhRaw, depth: m[2].charAt(0) === '=' ? 1 : 2, text: m[1].trim() });
      continue;
    }
    // Paragraph (top level only).
    if (top && (m = paraMain.exec(rest))) {
      const raw = m[0];
      const text = raw.charAt(raw.length - 1) === '\n' ? raw.slice(0, -1) : raw;
      rest = rest.slice(raw.length);
      const last = nodes[nodes.length - 1];
      if (inBlock && last && last.type === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
        last.text += '\n' + text;
        inBlock = false;
      } else {
        nodes.push({ type: 'paragraph', raw, text });
      }
      if (inBlock) inBlock = false;
      continue;
    }
    // Plain text line (only reached inside quotes and list items).
    if ((m = BLOCK.text.exec(rest))) {
      rest = rest.slice(m[0].length);
      const last = nodes[nodes.length - 1];
      if (last && last.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + m[0];
        last.text += '\n' + m[0];
      } else {
        nodes.push({ type: 'text', raw: m[0], text: m[0] });
      }
      continue;
    }
    throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
  }
  return nodes;
}

// Parse a list starting at the beginning of `src`. Returns the list node or
// null when no item could be read.
function parseList(src, links) {
  const start = BLOCK.listStart.exec(src);
  if (!start) return null;
  const full = src;
  let bullet = start[1].trim();
  const ordered = bullet.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +bullet.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bullet = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  const itemRe = listItemRegex(bullet);
  // Sticky versions of the anchored item/hr patterns, so matching runs
  // at an offset into `full` without slicing the remainder per line (a
  // list with thousands of items made the per-line slice quadratic).
  const itemReY = new RegExp(itemRe.source.slice(1), 'y');
  const hrY = new RegExp(BLOCK.hr.source.slice(1), 'y');
  const lineAt = (p) => {
    const e = full.indexOf('\n', p);
    return e === -1 ? full.slice(p) : full.slice(p, e);
  };
  let sawBlank = false;
  let pos = 0;
  for (; pos < full.length;) {
    let emptyItem = false;
    let text = '';
    itemReY.lastIndex = pos;
    let m = itemReY.exec(full);
    hrY.lastIndex = pos;
    if (!m || hrY.test(full)) break;
    const startOff = pos;
    pos += m[0].length;
    const firstLine = m[2].split('\n', 1)[0];
    const bulletLen = m[1].length;
    let afterBullet = firstLine.replace(/^[ \t]+/, (v) => expandTabs(v, bulletLen));
    let nextLine = lineAt(pos);
    let firstEmpty = !afterBullet.trim();
    let indent;
    if (firstEmpty) {
      indent = bulletLen + 1;
    } else {
      indent = afterBullet.search(/[^ ]/);
      indent = indent > 4 ? 1 : indent;
      text = afterBullet.slice(indent);
      indent += bulletLen;
    }
    if (firstEmpty && BLANK_LINE_RE.test(nextLine)) {
      pos += nextLine.length + 1;
      emptyItem = true;
    }
    if (!emptyItem) {
      const nextBullet = cached.nextBullet(indent);
      const hrRe = cached.hr(indent);
      const fencesRe = cached.fencesBegin(indent);
      const headingRe = cached.headingBegin(indent);
      const htmlRe = cached.htmlBegin(indent);
      const bqRe = cached.blockquoteBegin(indent);
      for (; pos < full.length;) {
        const line = lineAt(pos);
        let expanded;
        nextLine = line;
        expanded = line.replace(/^[ \t]+/, (v) => expandTabs(v));
        // First non-space column of the expanded line (leading tabs
        // are already spaces). The break patterns below are all
        // `^ {0,n}` with n < indent, so a line starting at or past
        // `indent` — or a blank line — can never match them: skip the
        // six regex tests and take the continuation branch directly.
        let indentCol = 0;
        while (indentCol < expanded.length && expanded.charCodeAt(indentCol) === 32) indentCol++;
        const blankLine = !HAS_NON_WS.test(line);
        if (indentCol >= indent || blankLine) {
          text += '\n' + expanded.slice(indent);
        } else if (
          fencesRe.test(line) || headingRe.test(line) || htmlRe.test(line) ||
          bqRe.test(line) || nextBullet.test(line) || hrRe.test(line)
        ) {
          break;
        } else {
          if (
            firstEmpty ||
            afterBullet.replace(/\t/g, '    ').search(/[^ ]/) >= 4 ||
            fencesRe.test(afterBullet) || headingRe.test(afterBullet) ||
            htmlRe.test(afterBullet) || hrRe.test(afterBullet)
          ) {
            break;
          }
          let extra = line;
          if (/^ {0,3}(?:=+|-+) *$/.test(line) && BLOCK.lheadingGfm.test(`${afterBullet}\n${line}`)) {
            extra = `    ${expanded.replace(/^ {0,3}/, '')}`;
          }
          text += '\n' + extra;
        }
        firstEmpty = blankLine;
        pos += line.length + 1;
        afterBullet = expanded.slice(indent);
      }
    }
    const itemRaw = full.slice(startOff, pos);
    if (!list.loose) {
      if (sawBlank) list.loose = true;
      else if (DOUBLE_BLANK_RE.test(itemRaw)) sawBlank = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: LIST_IS_TASK_RE.test(text),
      loose: false,
      text,
      children: null,
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = full.slice(0, pos).trimEnd();
  // Parse each item's contents as blocks (top level off, so paragraphs
  // become plain text nodes unless the list turns out loose).
  for (const item of list.items) {
    item.children = blockParse(item.text, links, false, false);
    if (!list.loose) {
      const spaces = item.children.filter((c) => c.type === 'space');
      if (spaces.length > 0 && spaces.some((c) => ANY_LINE_RE.test(c.raw))) list.loose = true;
    }
  }
  // Task list items: strip the "[ ] " / "[x] " marker from the first text
  // and remember the checkbox state; the renderer puts the <input> in.
  for (const item of list.items) {
    const first = item.children[0];
    if (item.task && first && (first.type === 'text' || first.type === 'paragraph')) {
      item.text = item.text.replace(LIST_REPLACE_TASK_RE, '');
      first.raw = first.raw.replace(LIST_REPLACE_TASK_RE, '');
      first.text = first.text.replace(LIST_REPLACE_TASK_RE, '');
      const cb = LIST_TASK_CB_RE.exec(item.raw);
      if (cb) item.checked = cb[0] !== '[ ]';
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const c of item.children) if (c.type === 'text') c.type = 'paragraph';
    }
  }
  return list;
}

// Parse a block quote starting at the beginning of `src` (which is the
// blockquote regex's match). Returns the blockquote node; its `raw` is the
// exact span consumed.
function parseBlockquote(src, links) {
  let lines = stripEnd(src, '\n').split('\n');
  let raw = '';
  let text = '';
  const children = [];
  while (lines.length > 0) {
    let seenMarker = false;
    const chunk = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (BQ_START_RE.test(lines[p])) {
        chunk.push(lines[p]);
        seenMarker = true;
      } else if (!seenMarker) {
        chunk.push(lines[p]);
      } else {
        break;
      }
    }
    lines = lines.slice(p);
    const joined = chunk.join('\n');
    const stripped = joined
      .replace(BQ_MARKER_WS_RE, (g, b, m) => b + expandTabs(m, b.length))
      .replace(BQ_SETEXT_RE, '\n    $1')
      .replace(BQ_SETEXT2_RE, '');
    raw = raw ? `${raw}\n${joined}` : joined;
    text = text ? `${text}\n${stripped}` : stripped;
    blockParse(stripped, links, true, true, children);
    if (lines.length === 0) break;
    const last = children[children.length - 1];
    if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table')) {
      break;
    }
    if (last && last.type === 'blockquote') {
      const restText = lines.join('\n');
      const reparsed = restText.replace(BQ_SETEXT2_RE, '');
      const again = parseBlockquote(`${last.raw}\n${reparsed}`, links);
      children[children.length - 1] = again;
      const remaining = `${last.raw}\n${reparsed}`.substring(again.raw.length).replace(/^\n/, '');
      const remLines = remaining ? remaining.split('\n').length : 0;
      const consumedLines = remLines ? lines.slice(0, -remLines) : lines;
      if (consumedLines.length > 0) raw = `${raw}\n${consumedLines.join('\n')}`;
      text = text.substring(0, text.length - last.text.length) + again.text;
      lines = lines.slice(consumedLines.length);
      if (lines.length > 0 && BQ_START_RE.test(lines[0])) continue;
      break;
    } else if (last && last.type === 'list') {
      const restText = `${last.raw}\n${lines.join('\n')}`;
      const again = parseList(restText, links);
      children[children.length - 1] = again;
      const extra = again.raw.length > last.raw.length
        ? restText.slice(last.raw.length + 1, again.raw.length).split('\n').length
        : 0;
      if (extra > 0) {
        const taken = lines.slice(0, extra).join('\n');
        raw = `${raw}\n${taken}`;
        text = `${text}\n${taken}`;
      }
      lines = lines.slice(extra);
      continue;
    }
  }
  return { type: 'blockquote', raw, text, children };
}

// ---- renderer --------------------------------------------------------------

// Inline-render one top-level text source: like marked's lex loop, the
// inRawBlock flag is reset before each block's inline pass.
function inlineTop(text, defs, ctx) {
  ctx.inRawBlock = false;
  return inlineParse(text, defs, ctx);
}

function renderCode(node) {
  const firstWord = (node.lang || '').match(NOT_SPACE_START_RE)?.[0];
  const body = node.text ? node.text.replace(ENDING_NEWLINE_RE, '') + '\n' : '';
  const open = firstWord ? `<pre><code class="language-${escapeNoEncode(firstWord)}">` : '<pre><code>';
  return open + escapeHtml(body) + '</code></pre>\n';
}

function renderTable(node, defs, ctx) {
  const cell = (c) => {
    const tag = c.header ? 'th' : 'td';
    const open = c.align ? `<${tag} align="${c.align}">` : `<${tag}>`;
    return open + inlineTop(c.text, defs, ctx) + `</${tag}>\n`;
  };
  const row = (inner) => `<tr>\n${inner}</tr>\n`;
  let headHtml = '';
  for (const c of node.header) headHtml += cell(c);
  let bodyHtml = '';
  for (const r of node.rows) {
    let inner = '';
    for (const c of r) inner += cell(c);
    bodyHtml += row(inner);
  }
  if (bodyHtml) bodyHtml = `<tbody>${bodyHtml}</tbody>`;
  return `<table>\n<thead>\n${row(headHtml)}</thead>\n${bodyHtml}</table>\n`;
}

function renderListItem(item, defs, ctx) {
  const first = item.children[0];
  let checkbox = '';
  let innerPrefix = '';
  if (item.task && first && (first.type === 'text' || first.type === 'paragraph')) {
    checkbox = `<input ${item.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
    if (item.loose) {
      innerPrefix = checkbox;
      checkbox = '';
    }
  }
  let body = '';
  for (let i = 0; i < item.children.length; i++) {
    const child = item.children[i];
    if (i === 0 && innerPrefix) {
      if (child.type === 'paragraph') body += `<p>${innerPrefix}${inlineTop(child.text, defs, ctx)}</p>\n`;
      else if (child.type === 'text') body += innerPrefix + inlineTop(child.text, defs, ctx);
      else body += renderNode(child, defs, ctx);
    } else {
      body += renderNode(child, defs, ctx);
    }
  }
  return `<li>${checkbox}${body}</li>\n`;
}

function renderNode(node, defs, ctx) {
  switch (node.type) {
    case 'space':
    case 'def':
      return '';
    case 'code':
      return renderCode(node);
    case 'heading':
      return `<h${node.depth}>${inlineTop(node.text, defs, ctx)}</h${node.depth}>\n`;
    case 'hr':
      return '<hr>\n';
    case 'html':
      return node.text;
    case 'paragraph':
      return `<p>${inlineTop(node.text, defs, ctx)}</p>\n`;
    case 'text':
      return inlineTop(node.text, defs, ctx);
    case 'table':
      return renderTable(node, defs, ctx);
    case 'blockquote':
      return `<blockquote>\n${renderBlocks(node.children, defs, ctx)}</blockquote>\n`;
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== 1 ? ` start="${node.start}"` : '';
      let body = '';
      for (const item of node.items) body += renderListItem(item, defs, ctx);
      return `<${tag}${start}>\n${body}</${tag}>\n`;
    }
    default:
      return '';
  }
}

function renderBlocks(nodes, defs, ctx) {
  let out = '';
  for (const n of nodes) out += renderNode(n, defs, ctx);
  return out;
}

// ---- entrypoint ------------------------------------------------------------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const defs = Object.create(null);
  const nodes = blockParse(src, defs, true, false);
  const ctx = freshCtx(false);
  return renderBlocks(nodes, defs, ctx);
}








// Try to match a GFM extended autolink at `s[i]`: a mailto:/xmpp:
// address, a scheme:// URL, a www. URL, or a bare email address. Returns
// {html, end} or null. Boundary rules, from marked's text tokenizer:
// mailto:/xmpp: needs a non-alphanumeric character (or the start) before
// it; www. needs the start, whitespace, `*`, `_`, `~` or `(` before it; a
// bare email needs a character that cannot start an email local part (or
// the start) before it. `prevChar` is the previous emitted text character
// ("" when the previous token was not plain text). Scheme and www. URLs are
// backpedalled the way marked does: trailing punctuation goes, balanced
// parens stay, a trailing `&name;` goes.
function tryUrl(s, i, ctx, prevChar) {
  const n = s.length;
  let m;
  EMAIL_PROTO_Y.lastIndex = i;
  m = EMAIL_PROTO_Y.exec(s);
  if (m) {
    if (prevChar && /[A-Za-z0-9]/.test(prevChar)) return null;
    let text = m[0];
    let cur = text;
    let prev;
    do {
      prev = cur;
      cur = BACKPEDAL_RE.exec(cur)?.[0] ?? '';
    } while (prev !== cur);
    text = cur;
    if (!text) return null;
    if (ctx.plain) return { html: text, end: i + text.length };
    return { html: '<a href="' + encodeHrefStrict(text) + '">' + escapeHtml(text) + '</a>', end: i + text.length };
  }
  let isWww = false;
  SCHEME_URL_Y.lastIndex = i;
  m = SCHEME_URL_Y.exec(s);
  if (!m) {
    WWW_URL_Y.lastIndex = i;
    m = WWW_URL_Y.exec(s);
    isWww = true;
  }
  if (m) {
    if (isWww && prevChar && !/[\s*_~(]/.test(prevChar)) return null;
    let text = m[0];
    let cur = text;
    let prev;
    do {
      prev = cur;
      cur = BACKPEDAL_RE.exec(cur)?.[0] ?? '';
    } while (prev !== cur);
    text = cur;
    if (!text) return null;
    const href = isWww ? 'http://' + text : text;
    if (ctx.plain) return { html: text, end: i + text.length };
    return { html: '<a href="' + encodeHrefStrict(href) + '">' + escapeHtml(text) + '</a>', end: i + text.length };
  }
  // Bare email: only worth running the regex when an `@` actually
  // follows inside this run of local-part characters (a hand scan is
  // far cheaper than the regex's backtracking at every word position).
  // And the local part can only start at `i` when the previous token
  // did not end in an email-local character (a flushed buffer, or a
  // non-local previous character), or the previous source character
  // is not email-local, or it was an escaped punctuation character
  // (an escape token ends the previous text run, so marked starts a
  // fresh email there — e.g. `a\_b@c.d` links `b@c.d`, and `a_b_c@d.e`
  // links `c@d.e` after the emphasis closer flushes the buffer).
  m = null;
  if (!prevChar || !isEmailLocal(prevChar.charCodeAt(0)) || i === 0 || !isEmailLocal(s.charCodeAt(i - 1)) || (i >= 2 && s[i - 2] === '\\' && isPunct(s[i - 1]))) {
    let j = i;
    while (j < n && isEmailLocal(s.charCodeAt(j))) j++;
    if (j > i && j < n && s[j] === '@') {
      BARE_EMAIL_Y.lastIndex = i;
      m = BARE_EMAIL_Y.exec(s);
    }
  }
  if (m) {
    const text = m[0];
    if (ctx.plain) return { html: text, end: i + text.length };
    return { html: '<a href="' + encodeHrefStrict('mailto:' + text) + '">' + escapeHtml(text) + '</a>', end: i + text.length };
  }
  return null;
}




