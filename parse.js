// parse.js — a fast, dependency-free re-implementation of marked 18.1.3's
// default rendering (gfm on, breaks off, pedantic off). parse(markdown)
// returns exactly the HTML marked.parse(markdown) returns for every input.
//
// Design: two phases, like marked's own pipeline, but without token trees.
//   1. Block phase: a cursor loop over the source that produces a small
//      tree of block nodes. Link reference definitions are collected into a
//      map as they are met; inline rendering is deferred until the whole
//      document has been block-parsed, so a definition anywhere in the
//      document applies to references anywhere else.
//   2. Render phase: each block node is rendered straight to an HTML
//      string; inline spans are rendered directly to HTML by a single
//      left-to-right scanner (no intermediate token list).
// All state lives inside one parse() call; nothing is shared between calls.

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// ---- small shared regexes (no /g, so exec() is stateless) -----------------
const R = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand:
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^\[])\^/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  // inline pieces
  punct: /[\p{P}\p{S}]/u,
  punctSpace: /[\s\p{P}\p{S}]/u,
  notPunctSpace: /[^\s\p{P}\p{S}]/u,
  openQuote: /[\p{Pi}\p{Ps}"']/u,
};

// ---- helpers ---------------------------------------------------------------

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape HTML special characters. When `encode` is false, well-formed
// entities and numeric character references are left alone.
function esc(s, encode) {
  if (encode) {
    if (R.escapeTest.test(s)) return s.replace(R.escapeReplace, (c) => ESC_MAP[c]);
    return s;
  }
  if (R.escapeTestNoEncode.test(s)) return s.replace(R.escapeReplaceNoEncode, (c) => ESC_MAP[c]);
  return s;
}

// Resolve numeric character references; a bare `&` that is not part of a
// valid reference becomes `&amp;`. Mirrors marked's unescape().
function unescapeEntities(s) {
  if (!R.numericCharacterReference.test(s)) return s;
  return s.replace(R.numericCharacterReferenceOrAmpersand, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// Percent-encode a link destination the way marked does (encodeURI, but a
// literal %25 stays %25).
function encodeHref(href) {
  try {
    return encodeURI(href).replace(R.percentDecode, '%');
  } catch {
    return null;
  }
}

// Normalise a link label for the definitions map: collapse whitespace,
// lowercase, then uppercase, then lowercase again (marked's label folding).
function foldLabel(label) {
  return label.trim().replace(R.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Split a table row on unescaped pipes, trimming cells and unescaping \|.
function splitRow(row, count) {
  const t = row.replace(R.findPipe, (ch, off, str) => {
    let escaped = false;
    let p = off;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(R.splitPipe);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(R.slashPipe, '|');
  return cells;
}

// Strip `count` trailing copies of `ch` from the end of `s` (marked's trimEnd helper).
function stripEnd(s, ch) {
  const n = s.length;
  let i = 0;
  for (; i < n;) {
    const c = s.charAt(n - i - 1);
    if (c === ch) i++;
    else break;
  }
  return s.slice(0, n - i);
}

// Remove up to two trailing blank lines from the end of an indented code block.
function trimCodeEnd(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && R.blankLine.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
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

// Count balanced parens in `s`: returns the index of the closing paren that
// brings the depth below zero, -2 when the string ends still open, else -1.
function parenDepth(s) {
  if (s.indexOf('(') === -1 && s.indexOf(')') === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '(') depth++;
    else if (s[i] === ')' && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// ---- block-level patterns --------------------------------------------------
//
// These are the same shapes marked uses: a block is recognised by trying
// each pattern in order at the current position of the remaining source.
// `edit` is a tiny template helper (the same idea as marked's): it takes a
// regex, substitutes named placeholders, and returns a fresh regex.

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
      /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/
    )
    .getRegex();
  const listStart = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, bullet).getRegex();
  const htmlComment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
  const htmlBlock = edit(
    "^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))",
    'i'
  )
    .replace('comment', htmlComment)
    .replace('tag', BLOCK_TAGS)
    .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
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
    nextBullet: cache((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
    hr: cache((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
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
  return new RegExp(`^( {0,3}${bullet})((?:[ \t][^\\n]*)?(?:\\n|$))`);
}

// ---- inline-level patterns -------------------------------------------------

const INLINE = (() => {
  const punct = '[\\p{P}\\p{S}]';
  const punctSpace = '[\\s\\p{P}\\p{S}]';
  const notPunctSpace = '[^\\s\\p{P}\\p{S}]';
  const punctTilde = '(?!~)[\\p{P}\\p{S}]';
  const punctSpaceTilde = '(?!~)[\\s\\p{P}\\p{S}]';
  const notPunctSpaceTilde = '(?:[^\\s\\p{P}\\p{S}]|~)';

  const escape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
  const code = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
  const br = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
  const punctuation = new RegExp(`^((?![*_])${punctSpace})`, 'u');

  // Delimiter runs that may open emphasis / strong emphasis.
  const emStrongLDelim = new RegExp(
    `^(?:\\*+(?:((?!\\*)${punctTilde})|([^\\s*]))?)|^_+(?:((?!_)${punctTilde})|([^\\s_]))?`,
    'u'
  );
  // Runs that may close emphasis / strong emphasis (asterisk flavour).
  const emStrongRDelimAst = new RegExp(
    `^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)${punctTilde}(\\*+)(?=[\\s]|$)|${notPunctSpaceTilde}(\\*+)(?!\\*)(?=${punctSpaceTilde}|$)|(?!\\*)${punctSpaceTilde}(\\*+)(?=${notPunctSpaceTilde})|[\\s](\\*+)(?!\\*)(?=${punctTilde})|(?!\\*)${punctTilde}(\\*+)(?!\\*)(?=${punctTilde})|${notPunctSpaceTilde}(\\*+)(?=${notPunctSpaceTilde})`,
    'gu'
  );
  // Runs that may close emphasis / strong emphasis (underscore flavour).
  // Note: unlike the asterisk flavour, there is no closer flanked by
  // non-punctuation on both sides, so intra-word underscores never close.
  const emStrongRDelimUnd = new RegExp(
    `^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)${punct}(_+)(?=[\\s]|$)|${notPunctSpace}(_+)(?!_)(?=${punctSpace}|$)|(?!_)${punctSpace}(_+)(?=${notPunctSpace})|[\\s](_+)(?!_)(?=${punct})|(?!_)${punct}(_+)(?!_)(?=${punct})`,
    'gu'
  );
  // Strikethrough delimiters.
  const delLDelim = new RegExp(`^~~?(?:((?!~)${punct})|[^\\s~])`, 'u');
  const delRDelim = new RegExp(
    `^[^~]+(?=[^~])|(?!~)${punct}(~~?)(?=[\\s]|$)|${notPunctSpace}(~~?)(?!~)(?=${punctSpace}|$)|(?!~)${punctSpace}(~~?)(?=${notPunctSpace})|[\\s](~~?)(?!~)(?=${punct})|(?!~)${punct}(~~?)(?!~)(?=${punct})|${notPunctSpace}(~~?)(?=${notPunctSpace})`,
    'gu'
  );
  const del = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

  const anyPunctuation = new RegExp(`\\\\(${punct})`, 'gu');
  const anyPunctuationOutsideCode = new RegExp(
    '(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\(' + punct + ')',
    'gu'
  );

  // Autolink <scheme:...> and <email>.
  const autolink = edit(
    /^<(scheme:[^\s\x00-\x1f<>]*|email)>/
  )
    .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
    .replace(
      'email',
      /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/
    )
    .getRegex();

  // Inline HTML tag.
  const htmlComment = /<!--(?:-?>|[\s\S]*?-->)/;
  const tag = edit(
    '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>'
  )
    .replace('comment', htmlComment)
    .replace(
      'attribute',
      /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/
    )
    .getRegex();

  // Link label / reference pieces.
  const bracketed = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
  const label = edit(
    /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/
  )
    .replace('brackets', bracketed)
    .getRegex();
  const refInner = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
  const link = edit(
    /^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/
  )
    .replace('label', label)
    .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
    .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
    .getRegex();
  const reflink = edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', label)
    .replace('ref', refInner)
    .getRegex();
  const nolink = edit(/^!?\[(ref)\](?:\[\])?/).replace('ref', refInner).getRegex();

  // The search pattern used to mask link-like text before emphasis scanning.
  const labelLoose = edit(
    /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/
  )
    .replace('brackets', bracketed)
    .getRegex();
  const refLoose = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
  const reflinkSearch = edit('reflink|nolink(?!\\()', 'g')
    .replace(
      'reflink',
      edit(/^!?\[(label)\]\[(ref)\]/).replace('label', labelLoose).replace('ref', refLoose).getRegex()
    )
    .replace(
      'nolink',
      edit(/^!?\[(ref)\](?:\[\])?/).replace('ref', refLoose).getRegex()
    )
    .getRegex();
  // Links / code spans / tags, masked out before emphasis scanning.
  const blockSkip = edit('link|precode-code|html', 'g')
    .replace(
      'link',
      /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/
    )
    .replace('precode-', '(?<!`)()')
    .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
    .replace('html', /<(?! )[^<>]*?>/)
    .getRegex();

  // Extended autolinks: scheme://, www., and bare email addresses.
  const emailLocal = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
  const url = edit(
    /^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/
  )
    .replace(
      'emailProtocol',
      edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, emailLocal).getRegex()
    )
    .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
    .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
    .getRegex();
  const backpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

  // Plain text: runs up to the next interesting character.
  const text = edit(
    /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/
  )
    .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
    .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
    .replace('wwwStart', /(?<![^\s*_~(])www\./)
    .getRegex();

  return {
    escape, code, br, punctuation, emStrongLDelim, emStrongRDelimAst, emStrongRDelimUnd,
    delLDelim, delRDelim, del, anyPunctuation, anyPunctuationOutsideCode, autolink, tag,
    link, reflink, nolink, reflinkSearch, blockSkip, url, backpedal, text,
  };
})();

// ---- inline engine ---------------------------------------------------------
//
// The inline scanner renders straight to HTML. It keeps one shared state
// object per parse() (inLink / inRawBlock / linkEmitted / linkParenPossible)
// because marked's lexer state leaks across inline runs in exactly the same
// way: inRawBlock is reset before each block's inline pass, the rest carry
// over.
//
// Emphasis uses marked's delimiter algorithm: before scanning, the source is
// "masked" — link labels, code spans, tags and escaped punctuation are
// replaced by same-length filler so that delimiters inside them cannot act
// as closers — and the last possible closer position for each delimiter is
// precomputed by one scan.

function isCloserPrecededOk(ch) {
  return ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r' && ch !== '\f';
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
    if (isCloserPrecededOk(prev)) {
      if (ch === '~') tilde = s;
      else if (ch === '*') star = s;
      else under = s;
    }
    s = i - 1;
  }
  return { star, under, tilde };
}

// Does `text` contain a link (inline or reference) that marked would accept?
// Used while masking, to decide whether a [..][..] span hides its label.
function linkInText(text, links) {
  if (!text.includes('[')) return false;
  INLINE.blockSkip.lastIndex = 0;
  for (const m of text.matchAll(INLINE.blockSkip)) {
    if (INLINE.link.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  INLINE.reflinkSearch.lastIndex = 0;
  for (const m of text.matchAll(INLINE.reflinkSearch)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (
      !(s.charAt(0) === '!' || !Object.hasOwn(links, foldLabel(s.slice(r + 1, -1)))) &&
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
    INLINE.reflinkSearch.lastIndex = 0;
    t = t.replace(INLINE.reflinkSearch, (whole) => {
      const o = whole.lastIndexOf('[');
      if (!Object.hasOwn(links, foldLabel(whole.slice(o + 1, -1)))) return whole;
      if (o > 1 && whole.charAt(0) !== '!') {
        const inner = whole.slice(1, o - 1);
        if (linkInText(inner, links)) {
          return '[' + inner.replace(INLINE.reflinkSearch, maskReflink) + '][' + 'a'.repeat(whole.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(whole.length - 2) + ']';
    });
  }
  function maskReflink(whole) {
    const o = whole.lastIndexOf('[');
    if (!Object.hasOwn(links, foldLabel(whole.slice(o + 1, -1)))) return whole;
    if (o > 1 && whole.charAt(0) !== '!') {
      const inner = whole.slice(1, o - 1);
      if (linkInText(inner, links)) {
        return '[' + inner.replace(INLINE.reflinkSearch, maskReflink) + '][' + 'a'.repeat(whole.length - o - 2) + ']';
      }
    }
    return '[' + 'a'.repeat(whole.length - 2) + ']';
  }
  t = t.replace(INLINE.anyPunctuationOutsideCode, (whole, ticks, punct) =>
    punct ? '+'.repeat(whole.length) : ticks ? ticks + whole.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks : whole
  );
  t = t.replace(INLINE.blockSkip, (whole, pre) => {
    const o = pre ? pre.length : 0;
    return whole.slice(0, o) + '[' + 'a'.repeat(whole.length - o - 2) + ']';
  });
  return t;
}

// Try to match an emphasis / strong emphasis opener at the start of `src`.
// `masked` is the masked full inline source, `offset` the position of `src`
// inside it, `prevChar` the previous emitted character ("" when the previous
// token was not plain text). Returns {raw, inner, strong} or null.
function tryEmStrong(src, masked, offset, prevChar, closers) {
  const m = INLINE.emStrongLDelim.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const delim = m[0][0];
  const sameAsPrev = prevChar === delim;
  const i = offset;
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  const prev = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const prevDelimOrPunct = prev === '*' || prev === '_' || !!INLINE.punctuation.exec(prev);
  if (l < i) prevChar = prev;
  const nextIsPunct = l < i ? prevDelimOrPunct : !!INLINE.punctuation.exec(prevChar);
  if (m[4] && prevChar.match(R.unicodeAlphaNumeric)) return null;
  const afterPunct = m[1] || m[3] || '';
  if (!afterPunct || !prevChar || nextIsPunct) {
    const run = [...m[0]].length - 1; // opening delimiter count
    let open = run;
    let extra = 0;
    const y = i - l + run;
    const ruleOfThree = !!prev.trim() && (!!afterPunct || (delim === '*' && !prevDelimOrPunct));
    if (delim !== '*' && delim !== '_') return null;
    const rdelim = delim === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
    const last = delim === '*' ? closers.star : closers.under;
    const q = i + run;
    if (last < q) return null;
    const rest = masked.slice(q);
    const limit = last - q;
    rdelim.lastIndex = 0;
    let s;
    while ((s = rdelim.exec(rest)) !== null && !(s.index > limit)) {
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      const b0 = [...g].length;
      if (s[3] || s[4]) {
        open += b0;
        continue;
      } else if (s[5] || s[6] || ruleOfThree) {
        if (sameAsPrev && (s[5] || s[6])) break;
        if (y % 3 && !((y + b0) % 3)) {
          extra += b0;
          continue;
        }
      }
      open -= b0;
      if (open > 0) continue;
      const b = Math.min(b0, b0 + open + extra);
      const lead = [...s[0]][0].length;
      const raw = src.slice(0, run + s.index + lead + b);
      if (Math.min(run, b) % 2) {
        return { raw, inner: raw.slice(1, -1), strong: false };
      }
      return { raw, inner: raw.slice(2, -2), strong: true };
    }
  }
  return null;
}

// Try to match a strikethrough opener at the start of `src`.
function tryDel(src, masked, offset, prevChar, closers) {
  const m = INLINE.delLDelim.exec(src);
  if (!m) return null;
  if (!(m[1] || '') || !prevChar || INLINE.punctuation.exec(prevChar)) {
    const run = [...m[0]].length - 1; // number of ~ characters
    let open = run;
    const rdelim = INLINE.delRDelim;
    const d = offset + run;
    if (closers.tilde < d) return null;
    const rest = masked.slice(d);
    const limit = closers.tilde - d;
    rdelim.lastIndex = 0;
    let s;
    while ((s = rdelim.exec(rest)) !== null && !(s.index > limit)) {
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      let len = [...g].length;
      if (len !== run) continue;
      if (s[3] || s[4]) {
        open += len;
        continue;
      }
      open -= len;
      if (open > 0) continue;
      len = Math.min(len, len + open);
      const lead = [...s[0]][0].length;
      const raw = src.slice(0, run + s.index + lead + len);
      return { raw, inner: raw.slice(run, -run) };
    }
  }
  return null;
}

// True when the link text `label` (starting at `start`, the offset of `[`
// inside it) hides an autolink or tag that would make an inline link invalid
// — marked's `Be` guard, which stops `[a <b> c](url)` from becoming a link.
function linkTextHasTag(src, label, start, links) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const code = INLINE.code.exec(label.slice(s));
      if (code) {
        s += code[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(start + s);
    const tag = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (tag) {
      if (tag[0].length > label.length - s) return true;
      s += tag[0].length - 1;
    }
  }
  return false;
}

// Render one inline link / image. `m` is the link or reflink match, `dest`
// and `title` already unescaped; `labelText` is the raw link text. Returns
// the HTML string, or null when the link must not be formed (a link was
// already emitted inside its text).
function renderLink(m, dest, title, labelText, ctx, plain = false) {
  const isImage = m[0].charAt(0) === '!';
  const text = labelText.replace(R.outputLinkReplace, '$1');
  const savedInLink = ctx.state.inLink;
  const savedEmitted = ctx.state.linkEmitted;
  const savedRaw = ctx.state.inRawBlock;
  ctx.state.inLink = true;
  ctx.state.linkEmitted = false;
  const inner = plain ? plainText(text, ctx) : inlineHtml(text, ctx);
  const nested = ctx.state.linkEmitted;
  ctx.state.linkEmitted = savedEmitted;
  ctx.state.inLink = savedInLink;
  if (!isImage) {
    if (nested) {
      ctx.state.inRawBlock = savedRaw;
      return null;
    }
    ctx.state.linkEmitted = true;
  }
  if (plain) return inner;
  const href = dest.replace(INLINE.anyPunctuation, '$1');
  const ttl = title ? title.replace(INLINE.anyPunctuation, '$1') : '';
  if (isImage) {
    const alt = plainText(text, ctx);
    const enc = encodeHref(href);
    if (enc === null) return esc(alt);
    let out = `<img src="${esc(enc)}" alt="${esc(alt)}"`;
    if (ttl) out += ` title="${esc(ttl)}"`;
    return out + '>';
  }
  const enc = encodeHref(href);
  if (enc === null) return inner;
  let out = `<a href="${esc(enc, false)}"`;
  if (ttl) out += ` title="${esc(ttl)}"`;
  return out + '>' + inner + '</a>';
}

// Render `src` as plain text (the text renderer): all formatting stripped,
// entities resolved, no tags at all. Used for image alt text.
function plainText(src, ctx) {
  // Reuse the inline scanner with a flag that drops markup; simpler and
  // exactly equivalent: parse inline and strip tags is wrong, so walk the
  // same token decisions with a plain renderer.
  return inlineHtml(src, ctx, true);
}

// Render inline markdown `src` to HTML. `ctx` carries the shared lexer
// state and the link definitions. When `plain` is true, formatting is
// stripped (image alt text).
function inlineHtml(src, ctx, plain = false) {
  const links = ctx.links;
  const state = ctx.state;
  const savedParen = state.linkParenPossible;
  state.linkParenPossible = savedParen && src.includes(')');
  try {
    return inlineScan(src, ctx, plain);
  } finally {
    state.linkParenPossible = savedParen;
  }
}

function inlineScan(src, ctx, plain) {
  const links = ctx.links;
  const state = ctx.state;
  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = needsMask ? maskSource(src, links) : src;
  const closers = needsMask ? lastCloserPositions(masked) : { star: -1, under: -1, tilde: -1 };
  let out = '';
  let rest = src;
  let offset = 0;
  let prevChar = '';
  let wasText = false;
  let guard = Infinity;
  while (rest) {
    if (rest.length < guard) guard = rest.length;
    else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    if (!wasText) prevChar = '';
    wasText = false;
    let m;

    // Backslash escape of an ASCII punctuation character.
    if ((m = INLINE.escape.exec(rest))) {
      out += plain ? m[1] : esc(m[1]);
      rest = rest.slice(m[0].length);
      offset += m[0].length;
      continue;
    }
    // Raw HTML tag.
    if ((m = INLINE.tag.exec(rest))) {
      if (!state.inLink && R.startATag.test(m[0])) state.inLink = true;
      else if (state.inLink && R.endATag.test(m[0])) state.inLink = false;
      if (!state.inRawBlock && R.startPreScriptTag.test(m[0])) state.inRawBlock = true;
      else if (state.inRawBlock && R.endPreScriptTag.test(m[0])) state.inRawBlock = false;
      if (!plain) out += m[0];
      rest = rest.slice(m[0].length);
      offset += m[0].length;
      continue;
    }
    // Inline link [text](href "title") / ![alt](src).
    if (state.linkParenPossible && (m = INLINE.link.exec(rest))) {
      const bang = m[0].charAt(0) === '!' ? 2 : 1;
      if (!linkTextHasTag(rest, m[1], bang, links)) {
        let href = m[2].trim();
        let title = '';
        let ok = true;
        let rawLen = m[0].length;
        if (R.startAngleBracket.test(href)) {
          if (!R.endAngleBracket.test(href)) ok = false;
          else {
            const stripped = stripEnd(href.slice(0, -1), '\\');
            if ((href.length - stripped.length) % 2 === 0) ok = false;
          }
        } else {
          const depth = parenDepth(m[2]);
          if (depth === -2) ok = false;
          else if (depth > -1) {
            const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + depth;
            href = m[2].substring(0, depth);
            rawLen = cut;
            m = [m[0].substring(0, cut).trim(), m[1], href, ''];
          }
        }
        if (ok) {
          const r = stripEnd(m[0].slice(0, -1), '\\');
          if ((m[0].length - r.length) % 2 === 0) ok = false;
        }
        if (ok) {
          title = m[3] ? m[3].slice(1, -1) : '';
          href = href.trim();
          if (R.startAngleBracket.test(href)) href = href.slice(1, -1);
          const html = renderLink(m, href, title, m[1], ctx, plain);
          if (html !== null) {
            out += html;
            rest = rest.slice(rawLen);
            offset += rawLen;
            continue;
          }
        }
      }
    }
    // Reference link [text][ref], [text][] or [text].
    if ((m = INLINE.reflink.exec(rest)) || (m = INLINE.nolink.exec(rest))) {
      const bang = m[0].charAt(0) === '!' ? 2 : 1;
      if (!linkTextHasTag(rest, m[1], bang, links)) {
        const def = links[foldLabel(m[2] || m[1])];
        if (!def) {
          const ch = m[0].charAt(0);
          out += plain ? ch : esc(ch);
          rest = rest.slice(1);
          offset += 1;
          continue;
        }
        const html = renderLink(m, def.href, def.title || '', m[1], ctx, plain);
        if (html !== null) {
          out += html;
          rest = rest.slice(m[0].length);
          offset += m[0].length;
          continue;
        }
      }
    }
    // Emphasis / strong emphasis.
    if (needsMask) {
      const em = tryEmStrong(rest, masked, offset, prevChar, closers);
      if (em) {
        const inner = inlineHtml(em.inner, ctx);
        out += plain ? inner : em.strong ? `<strong>${inner}</strong>` : `<em>${inner}</em>`;
        rest = rest.slice(em.raw.length);
        offset += em.raw.length;
        continue;
      }
    }
    // Code span.
    if ((m = INLINE.code.exec(rest))) {
      let text = m[2].replace(R.newLineCharGlobal, ' ');
      if (R.nonSpaceChar.test(text) && R.startingSpaceChar.test(text) && R.endingSpaceChar.test(text)) {
        text = text.substring(1, text.length - 1);
      }
      out += plain ? text : `<code>${esc(text, true)}</code>`;
      rest = rest.slice(m[0].length);
      offset += m[0].length;
      continue;
    }
    // Hard line break (two spaces or backslash before a newline).
    if ((m = INLINE.br.exec(rest))) {
      if (!plain) out += '<br>';
      rest = rest.slice(m[0].length);
      offset += m[0].length;
      continue;
    }
    // Strikethrough.
    if (needsMask) {
      const del = tryDel(rest, masked, offset, prevChar, closers);
      if (del) {
        const inner = inlineHtml(del.inner, ctx);
        out += plain ? inner : `<del>${inner}</del>`;
        rest = rest.slice(del.raw.length);
        offset += del.raw.length;
        continue;
      }
    }
    // Autolink <scheme:...> / <email>.
    if ((m = INLINE.autolink.exec(rest))) {
      let text;
      let href;
      if (m[2] === '@') {
        text = m[1];
        href = 'mailto:' + text;
      } else {
        text = m[1];
        href = text;
      }
      if (plain) {
        out += text;
      } else {
        const enc = encodeHref(href);
        out += enc === null ? esc(text, true) : `<a href="${esc(enc, true)}">${esc(text, true)}</a>`;
      }
      rest = rest.slice(m[0].length);
      offset += m[0].length;
      continue;
    }
    // Extended autolink (www. / scheme:// / bare email), never inside a link.
    if (!state.inLink && (m = INLINE.url.exec(rest))) {
      let text;
      let href;
      if (m[2] === '@') {
        text = m[0];
        href = 'mailto:' + text;
      } else {
        let cur = m[0];
        let prev;
        do {
          prev = cur;
          INLINE.backpedal.lastIndex = 0;
          cur = INLINE.backpedal.exec(cur)?.[0] ?? '';
        } while (prev !== cur);
        text = cur;
        href = m[1] === 'www.' ? 'http://' + cur : cur;
        m = [cur];
      }
      if (plain) {
        out += text;
      } else {
        const enc = encodeHref(href);
        out += enc === null ? esc(text, true) : `<a href="${esc(enc, true)}">${esc(text, true)}</a>`;
      }
      rest = rest.slice(m[0].length);
      offset += m[0].length;
      continue;
    }
    // Plain text up to the next interesting character.
    if ((m = INLINE.text.exec(rest))) {
      const raw = m[0];
      if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
      wasText = true;
      if (plain) {
        out += state.inRawBlock ? raw : unescapeEntities(raw);
      } else if (state.inRawBlock) {
        out += raw;
      } else {
        out += esc(unescapeEntities(raw));
      }
      rest = rest.slice(raw.length);
      offset += raw.length;
      continue;
    }
    throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
  }
  return out;
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
      const text = raw.replace(R.codeRemoveIndent, '');
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
      const fenceIndent = raw.match(R.indentCodeCompensation);
      if (fenceIndent) {
        const ind = fenceIndent[1];
        text = text
          .split('\n')
          .map((line) => {
            const lead = line.match(R.beginningSpace);
            if (!lead) return line;
            return line.slice(Math.min(lead[0].length, ind.length));
          })
          .join('\n');
      }
      const lang = m[2] ? m[2].trim().replace(INLINE.anyPunctuation, '$1') : m[2];
      rest = rest.slice(raw.length);
      nodes.push({ type: 'code', raw, text, lang });
      continue;
    }
    // ATX heading.
    if ((m = BLOCK.heading.exec(rest))) {
      let text = m[2].trim();
      if (R.endingHash.test(text)) {
        const stripped = stripEnd(text, '#');
        if (!stripped || R.endingSpaceTabChar.test(stripped)) text = stripped.trim();
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
      if (R.startAngleBracket.test(m[2]) || parenDepth(m[2]) === -1) {
        const tag = foldLabel(m[1]);
        const href = m[2] ? m[2].replace(R.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '';
        const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, '$1') : m[3];
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
      if (R.tableDelimiter.test(m[2])) {
        const head = splitRow(m[1]);
        const aligns = m[2].replace(R.tableAlignChars, '').split('|');
        if (head.length === aligns.length) {
          const align = [];
          for (const a of aligns) {
            if (R.tableAlignRight.test(a)) align.push('right');
            else if (R.tableAlignCenter.test(a)) align.push('center');
            else if (R.tableAlignLeft.test(a)) align.push('left');
            else align.push(null);
          }
          const header = head.map((t, i) => ({ text: t, header: true, align: align[i] }));
          const rows = [];
          if (m[3] && m[3].trim()) {
            for (const line of m[3].replace(R.tableRowBlankLine, '').split('\n')) {
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
  let sawBlank = false;
  let rest = src;
  for (; rest;) {
    let emptyItem = false;
    let text = '';
    let m = itemRe.exec(rest);
    if (!m || BLOCK.hr.test(rest)) break;
    const startOff = full.length - rest.length;
    rest = rest.slice(m[0].length);
    const firstLine = m[2].split('\n', 1)[0];
    const bulletLen = m[1].length;
    let afterBullet = firstLine.replace(R.leadingSpaceTab, (v) => expandTabs(v, bulletLen));
    let nextLine = rest.split('\n', 1)[0];
    let firstEmpty = !afterBullet.trim();
    let indent;
    if (firstEmpty) {
      indent = bulletLen + 1;
    } else {
      indent = afterBullet.search(R.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      text = afterBullet.slice(indent);
      indent += bulletLen;
    }
    if (firstEmpty && R.blankLine.test(nextLine)) {
      rest = rest.slice(nextLine.length + 1);
      emptyItem = true;
    }
    if (!emptyItem) {
      const nextBullet = cached.nextBullet(indent);
      const hrRe = cached.hr(indent);
      const fencesRe = cached.fencesBegin(indent);
      const headingRe = cached.headingBegin(indent);
      const htmlRe = cached.htmlBegin(indent);
      const bqRe = cached.blockquoteBegin(indent);
      for (; rest;) {
        const line = rest.split('\n', 1)[0];
        let expanded;
        nextLine = line;
        expanded = line.replace(R.leadingSpaceTab, (v) => expandTabs(v));
        if (
          fencesRe.test(line) || headingRe.test(line) || htmlRe.test(line) ||
          bqRe.test(line) || nextBullet.test(line) || hrRe.test(line)
        ) {
          break;
        }
        if (expanded.search(R.nonSpaceChar) >= indent || !line.trim()) {
          text += '\n' + expanded.slice(indent);
        } else {
          if (
            firstEmpty ||
            afterBullet.replace(R.tabCharGlobal, '    ').search(R.nonSpaceChar) >= 4 ||
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
        firstEmpty = !line.trim();
        rest = rest.slice(line.length + 1);
        afterBullet = expanded.slice(indent);
      }
    }
    const itemRaw = full.slice(startOff, full.length - rest.length);
    if (!list.loose) {
      if (sawBlank) list.loose = true;
      else if (R.doubleBlankLine.test(itemRaw)) sawBlank = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: R.listIsTask.test(text),
      loose: false,
      text,
      children: null,
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = full.slice(0, full.length - rest.length).trimEnd();
  // Parse each item's contents as blocks (top level off, so paragraphs
  // become plain text nodes unless the list turns out loose).
  for (const item of list.items) {
    item.children = blockParse(item.text, links, false, false);
    if (!list.loose) {
      const spaces = item.children.filter((c) => c.type === 'space');
      if (spaces.length > 0 && spaces.some((c) => R.anyLine.test(c.raw))) list.loose = true;
    }
  }
  // Task list items: strip the "[ ] " / "[x] " marker from the first text
  // and remember the checkbox state; the renderer puts the <input> in.
  for (const item of list.items) {
    const first = item.children[0];
    if (item.task && first && (first.type === 'text' || first.type === 'paragraph')) {
      item.text = item.text.replace(R.listReplaceTask, '');
      first.raw = first.raw.replace(R.listReplaceTask, '');
      first.text = first.text.replace(R.listReplaceTask, '');
      const cb = R.listTaskCheckbox.exec(item.raw);
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
      if (R.blockquoteStart.test(lines[p])) {
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
      .replace(R.blockquoteMarkerWhitespace, (g, b, m) => b + expandTabs(m, b.length))
      .replace(R.blockquoteSetextReplace, '\n    $1')
      .replace(R.blockquoteSetextReplace2, '');
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
      const reparsed = restText.replace(R.blockquoteSetextReplace2, '');
      const again = parseBlockquote(`${last.raw}\n${reparsed}`, links);
      children[children.length - 1] = again;
      const remaining = `${last.raw}\n${reparsed}`.substring(again.raw.length).replace(/^\n/, '');
      const remLines = remaining ? remaining.split('\n').length : 0;
      const consumedLines = remLines ? lines.slice(0, -remLines) : lines;
      if (consumedLines.length > 0) raw = `${raw}\n${consumedLines.join('\n')}`;
      text = text.substring(0, text.length - last.text.length) + again.text;
      lines = lines.slice(consumedLines.length);
      if (lines.length > 0 && R.blockquoteStart.test(lines[0])) continue;
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
function inlineTop(text, ctx) {
  ctx.state.inRawBlock = false;
  return inlineHtml(text, ctx);
}

function renderCode(node) {
  const firstWord = (node.lang || '').match(R.notSpaceStart)?.[0];
  const body = node.text ? node.text.replace(R.endingNewline, '') + '\n' : '';
  const open = firstWord ? `<pre><code class="language-${esc(firstWord)}">` : '<pre><code>';
  return open + esc(body, true) + '</code></pre>\n';
}

function renderTable(node, ctx) {
  const cell = (c) => {
    const tag = c.header ? 'th' : 'td';
    const open = c.align ? `<${tag} align="${c.align}">` : `<${tag}>`;
    return open + inlineTop(c.text, ctx) + `</${tag}>\n`;
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

function renderListItem(item, ctx) {
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
      if (child.type === 'paragraph') body += `<p>${innerPrefix}${inlineTop(child.text, ctx)}</p>\n`;
      else if (child.type === 'text') body += innerPrefix + inlineTop(child.text, ctx);
      else body += renderNode(child, ctx);
    } else {
      body += renderNode(child, ctx);
    }
  }
  return `<li>${checkbox}${body}</li>\n`;
}

function renderNode(node, ctx) {
  switch (node.type) {
    case 'space':
    case 'def':
      return '';
    case 'code':
      return renderCode(node);
    case 'heading':
      return `<h${node.depth}>${inlineTop(node.text, ctx)}</h${node.depth}>\n`;
    case 'hr':
      return '<hr>\n';
    case 'html':
      return node.text;
    case 'paragraph':
      return `<p>${inlineTop(node.text, ctx)}</p>\n`;
    case 'text':
      return inlineTop(node.text, ctx);
    case 'table':
      return renderTable(node, ctx);
    case 'blockquote':
      return `<blockquote>\n${renderBlocks(node.children, ctx)}</blockquote>\n`;
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== 1 ? ` start="${node.start}"` : '';
      let body = '';
      for (const item of node.items) body += renderListItem(item, ctx);
      return `<${tag}${start}>\n${body}</${tag}>\n`;
    }
    default:
      return '';
  }
}

function renderBlocks(nodes, ctx) {
  let out = '';
  for (const n of nodes) out += renderNode(n, ctx);
  return out;
}

// ---- entrypoint ------------------------------------------------------------

export function parse(markdown) {
  const src = String(markdown).replace(R.carriageReturn, '\n');
  const links = Object.create(null);
  const nodes = blockParse(src, links, true, false);
  const ctx = {
    links,
    state: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true },
  };
  return renderBlocks(nodes, ctx);
}
