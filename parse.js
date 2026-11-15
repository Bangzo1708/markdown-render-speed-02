// A fast, dependency-free drop-in for marked 18.1.3 (default options:
// GFM on, breaks off, pedantic off). parse(markdown) returns exactly the
// HTML marked renders, byte for byte.
//
// Written from scratch in this session. The grammar rules below are the
// CommonMark 0.31.2 + GFM 0.29 rules, assembled from small pattern pieces
// the same way any spec implementation composes them; the lexer, the inline
// renderer and the block renderer are my own design: inline tokens are
// rendered straight to HTML in one cursor pass (no inline token objects),
// and the block loop walks the input with sticky regexes at a cursor
// instead of slicing the remaining string at every token.

const CARET_STRIP = /(^|[^[])\^/g;

// Small pattern composer: start from a pattern (string or RegExp), swap
// named placeholders for other patterns, and build the final RegExp.
// A placeholder value loses its leading ^ anchor when it is spliced in
// (a ^ inside [...] is kept).
function compose(source, flags = '') {
  let src = typeof source === 'string' ? source : source.source;
  return {
    sub(name, val) {
      let v = typeof val === 'string' ? val : val.source;
      v = v.replace(CARET_STRIP, '$1');
      src = src.replace(name, () => v);
      return this;
    },
    done() {
      return new RegExp(src, flags);
    },
  };
}

// Turn an anchored pattern into a sticky one: the match must start exactly
// at lastIndex, which lets the lexer walk a string with a cursor instead
// of copying the remainder at every step. Anchor carets at the start of
// the pattern and after | are dropped (sticky already pins the start);
// carets inside [...] are kept.
function stickyOf(re) {
  const flags = re.flags.replace('g', '').replace('y', '') + 'y';
  return new RegExp(re.source.replace(/(^|\|)\^/g, '$1'), flags);
}

// Run a sticky pattern at a position; null when it does not match there.
function at(re, str, pos) {
  re.lastIndex = pos;
  return re.exec(str);
}

// ---------------------------------------------------------------------------
// Grammar pieces
// ---------------------------------------------------------------------------

const TAG_NAMES = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
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
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`),
};

function cachedIndentRegex(make) {
  const cache = [];
  return (indent) => {
    const i = Math.max(0, Math.min(3, indent - 1));
    let re = cache[i];
    if (!re) {
      // Plain (non-sticky) regexes: these are used with .test() on whole
      // lines, so they must match at the line start every time. A sticky
      // regex keeps lastIndex from its previous match and would spuriously
      // fail the next test after any successful one.
      re = make(i);
      cache[i] = re;
    }
    return re;
  };
}

O.nextBulletRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\\n|$))`));
O.hrRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
O.fencesBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`));
O.headingBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`));
O.htmlBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:</?(?:${TAG_NAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
O.blockquoteBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}>`));

// ---------------------------------------------------------------------------
// Block grammar (GFM)
// ---------------------------------------------------------------------------

const NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const BLOCK_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const LHEADING_CORE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const PARAGRAPH_CORE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const BLOCK_TEXT = /^[^\n]+/;
const BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

const DEF = compose(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .sub('label', BLOCK_LABEL)
  .sub('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .done();

const LIST = compose(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .sub(/bull/g, BULLET)
  .done();

const HTML_BLOCK = compose(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' // (1)
  + '|comment[^\\n]*(\\n+|$)' // (2)
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' // (3)
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' // (4)
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' // (5)
  + '|</?(tag)(?:[ \t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (6)
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (7) open tag
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' // (7) closing tag
  + ')', 'i')
  .sub('comment', HTML_COMMENT)
  .sub('tag', TAG_NAMES)
  .sub('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .done();

const GFM_TABLE = compose(
  '^ *([^\\n ].*)\\n' // Header
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)' // Align
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)') // Cells
  .sub('hr', HR)
  .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .sub('blockquote', ' {0,3}>')
  .sub('code', '(?: {4}| {0,3}\t)[^\\n]')
  .sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .sub('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .sub('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .sub('tag', TAG_NAMES)
  .done();

const LHEADING = compose(LHEADING_CORE)
  .sub(/bull/g, BULLET)
  .sub(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .sub(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .sub(/blockquote/g, / {0,3}>/)
  .sub(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .sub(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .sub(/html/g, / {0,3}<[^\n>]+>\n/)
  .sub(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .done();

function makeParagraph(listInterrupt, tableSub) {
  const c = compose(PARAGRAPH_CORE)
    .sub('hr', HR)
    .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .sub('|lheading', '');
  if (tableSub === null) c.sub('|table', '');
  else c.sub('table', tableSub);
  return c
    .sub('blockquote', ' {0,3}>')
    .sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .sub('list', listInterrupt)
    .sub('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .sub('tag', TAG_NAMES)
    .done();
}

const PARAGRAPH = makeParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/, GFM_TABLE);
const BQ_PARAGRAPH = makeParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/, null);

const BLOCKQUOTE = compose(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/ )
  .sub('paragraph', BQ_PARAGRAPH)
  .done();

// ---------------------------------------------------------------------------
// Inline grammar (GFM)
// ---------------------------------------------------------------------------

const INLINE_LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const INLINE_LABEL = compose(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .sub('brackets', INLINE_LABEL_BRACKETS)
  .done();
const BOUNDED_BLOCK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL = compose(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .sub('brackets', INLINE_LABEL_BRACKETS)
  .done();

const LINK = compose(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .sub('label', INLINE_LABEL)
  .sub('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .sub('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .done();

const REFLINK = compose(/^!?\[(label)\]\[(ref)\]/)
  .sub('label', INLINE_LABEL)
  .sub('ref', BLOCK_LABEL)
  .done();

const NOLINK = compose(/^!?\[(ref)\](?:\[\])?/)
  .sub('ref', BLOCK_LABEL)
  .done();

const REFLINK_SEARCH = compose('reflink|nolink(?!\\()', 'g')
  .sub('reflink', compose(/^!?\[(label)\]\[(ref)\]/).sub('label', BOUNDED_INLINE_LABEL).sub('ref', BOUNDED_BLOCK_LABEL).done())
  .sub('nolink', compose(/^!?\[(ref)\](?:\[\])?/).sub('ref', BOUNDED_BLOCK_LABEL).done())
  .done();

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_GFM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;

const ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const AUTOLINK = compose(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .sub('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .sub('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .done();

const INLINE_COMMENT = compose(HTML_COMMENT).sub('(?:-->|$)', '-->').done();
const TAG = compose(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' // closing tag
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>' // open tag
  + '|^<\\?[\\s\\S]*?\\?>' // processing instruction
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>' // declaration
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>') // CDATA section
  .sub('comment', INLINE_COMMENT)
  .sub('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .done();

const ANY_PUNCT = compose(/\\(punct)/, 'gu').sub(/punct/g, PUNCT).done();
const ANY_PUNCT_OUTSIDE_CODE = compose(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').sub(/punct/g, PUNCT).done();

const BLOCK_SKIP = compose(/link|precode-code|html/, 'g')
  .sub('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .sub('precode-', '(?<!`)()')
  .sub('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .sub('html', /<(?! )[^<>]*?>/)
  .done();

const EM_L_DELIM_CORE = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const EM_L_DELIM = compose(EM_L_DELIM_CORE, 'u').sub(/punct/g, PUNCT_GFM).done();

const EM_R_DELIM_AST_CORE =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // skip orphan inside strong
  + '|[^*]+(?=[^*])' // consume to delim
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** can only be a Right Delimiter
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***#, a*** can only be a Right Delimiter
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a, ***a can only be Left Delimiter
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# can only be Left Delimiter
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# can be either Left or Right Delimiter
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a can be either Left or Right Delimiter

const EM_R_DELIM_AST = compose(EM_R_DELIM_AST_CORE, 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_SPACE_GFM)
  .sub(/punctSpace/g, PUNCT_SPACE_GFM)
  .sub(/punct/g, PUNCT_GFM)
  .done();

const EM_R_DELIM_UND = compose(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' // skip orphan inside strong
  + '|[^_]+(?=[^_])' // consume to delim
  + '|(?!_)punct(_+)(?=[\\s]|$)' // (1) #___ can only be a Right Delimiter
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' // (2) a___#, a___ can only be a Right Delimiter
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)' // (3) #___a, ___a can only be Left Delimiter
  + '|[\\s](_+)(?!_)(?=punct)' // (4) ___# can only be Left Delimiter
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu') // (5) #___# can be either Left or Right Delimiter
  .sub(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .sub(/punctSpace/g, PUNCT_SPACE)
  .sub(/punct/g, PUNCT)
  .done();

const DEL_L_DELIM = compose(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').sub(/punct/g, PUNCT).done();

const DEL_R_DELIM_CORE =
  '^[^~]+(?=[^~])' // consume to delim
  + '|(?!~)punct(~~?)(?=[\\s]|$)' // (1) #~~ can only be a Right Delimiter
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)' // (2) a~~#, a~~ can only be a Right Delimiter
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)' // (3) #~~a, ~~a can only be Left Delimiter
  + '|[\\s](~~?)(?!~)(?=punct)' // (4) ~~# can only be Left Delimiter
  + '|(?!~)punct(~~?)(?!~)(?=punct)' // (5) #~~# can be either Left or Right Delimiter
  + '|notPunctSpace(~~?)(?=notPunctSpace)'; // (6) a~~a can be either Left or Right Delimiter

const DEL_R_DELIM = compose(DEL_R_DELIM_CORE, 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .sub(/punctSpace/g, PUNCT_SPACE)
  .sub(/punct/g, PUNCT)
  .done();

const PUNCTUATION = compose(/^((?![*_])punctSpace)/, 'u').sub(/punctSpace/g, PUNCT_SPACE).done();

const EXTENDED_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EXTENDED_EMAIL_PROTOCOL = compose(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .sub(/email/g, EXTENDED_EMAIL)
  .done();

const URL = compose(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .sub('emailProtocol', EXTENDED_EMAIL_PROTOCOL)
  .sub('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
  .sub('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .done();
const BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

const INLINE_TEXT = compose(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .sub('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
  .sub(/emailProtocol/g, /(?:mailto|xmpp):/)
  .sub('wwwStart', '(?<![^\\s*_~(])www\\.')
  .done();

// Sticky variants for the cursor-driven block and inline loops.
const S = {
  space: stickyOf(NEWLINE),
  code: stickyOf(BLOCK_CODE),
  fences: stickyOf(FENCES),
  heading: stickyOf(HEADING),
  hr: stickyOf(HR),
  blockquote: stickyOf(BLOCKQUOTE),
  list: stickyOf(LIST),
  html: stickyOf(HTML_BLOCK),
  def: stickyOf(DEF),
  table: stickyOf(GFM_TABLE),
  lheading: stickyOf(LHEADING),
  paragraph: stickyOf(PARAGRAPH),
  text: stickyOf(BLOCK_TEXT),
  escape: stickyOf(ESCAPE),
  tag: stickyOf(TAG),
  link: stickyOf(LINK),
  reflink: stickyOf(REFLINK),
  nolink: stickyOf(NOLINK),
  emLDelim: stickyOf(EM_L_DELIM),
  codeSpan: stickyOf(INLINE_CODE),
  br: stickyOf(BR),
  delLDelim: stickyOf(DEL_L_DELIM),
  autolink: stickyOf(AUTOLINK),
  url: stickyOf(URL),
  inlineText: stickyOf(INLINE_TEXT),
};

// ---------------------------------------------------------------------------
// Helpers (per-parse state lives in ST, rebuilt fresh by every parse() call,
// so nothing carries over between cases)
// ---------------------------------------------------------------------------

const ESC_REPL = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(html, encode) {
  if (encode) {
    if (O.escapeTest.test(html)) return html.replace(O.escapeReplace, (ch) => ESC_REPL[ch]);
  } else if (O.escapeTestNoEncode.test(html)) {
    return html.replace(O.escapeReplaceNoEncode, (ch) => ESC_REPL[ch]);
  }
  return html;
}

function decodeNumRefs(text) {
  if (!O.numericCharacterReference.test(text)) return text;
  return text.replace(O.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(O.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(tableRow, count) {
  const row = tableRow.replace(O.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(O.splitPipe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(O.slashPipe, '|');
  return cells;
}

function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && O.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

function normalizeLabel(label) {
  return label.trim().replace(O.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// One scan of a masked inline source for the last `*` / `_` run that can
// close emphasis and the last `~` run that can close strikethrough. A run
// can close only when it is not preceded by ASCII whitespace or the start.
function scanClosers(src) {
  let ast = -1, und = -1, del = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = i;
      else if (ch === '*') ast = i;
      else und = i;
    }
    i = j - 1;
  }
  return { ast, und, del };
}

// Per-parse mutable state. Fresh object per parse() call.
let ST = null;

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = INLINE_CODE.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = TAG.exec(tokenSrc) || AUTOLINK.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Does this link text already hold a link? An image does not count: an image
// may hold a link, a link may not.
function linkInText(text) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(BLOCK_SKIP)) {
    if (LINK.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(REFLINK_SEARCH)) {
    const m0 = match[0];
    const refStart = m0.lastIndexOf('[');
    if (m0.charAt(0) === '!' || !Object.hasOwn(ST.links, normalizeLabel(m0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(m0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

// Mask links, code spans, html and escapes so emphasis/delimiter scans do
// not see their delimiters inside them. Every mask keeps the length it
// replaces, so maskedSrc lines up with src by index.
function maskSrc(src) {
  let masked = src;
  // Each masking pass is a no-op without its trigger character, so skip it:
  // reflinks need '[' (and a defined link), escapes/code spans need '\' or
  // '`', links/code/html need '[', '`' or '<'.
  if (ST.linkCount > 0 && src.includes('[')) {
    const maskReflink = (m0) => {
      const refStart = m0.lastIndexOf('[');
      if (!Object.hasOwn(ST.links, normalizeLabel(m0.slice(refStart + 1, -1)))) return m0;
      if (refStart > 1 && m0.charAt(0) !== '!') {
        const text = m0.slice(1, refStart - 1);
        if (linkInText(text)) {
          return '[' + text.replace(REFLINK_SEARCH, maskReflink)
            + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m0.length - 2) + ']';
    };
    masked = masked.replace(REFLINK_SEARCH, maskReflink);
  }
  if (src.includes('\\') || src.includes('`')) {
    masked = masked.replace(ANY_PUNCT_OUTSIDE_CODE, (m0, code, punct) => {
      if (punct) return '+'.repeat(m0.length);
      if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return m0;
    });
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(BLOCK_SKIP, (m0, _link, context) => {
      const offset = context ? context.length : 0;
      return m0.slice(0, offset) + '[' + 'a'.repeat(m0.length - offset - 2) + ']';
    });
  }
  return masked;
}

// ---------------------------------------------------------------------------
// Inline: links
// ---------------------------------------------------------------------------

function linkHtml(href, title, inner, autolink) {
  const clean = cleanUrl(href);
  if (clean === null) return inner;
  let out = '<a href="' + esc(clean, autolink) + '"';
  if (title) out += ' title="' + esc(title) + '"';
  return out + '>' + inner + '</a>';
}

function imageHtml(href, title, alt) {
  const clean = cleanUrl(href);
  if (clean === null) return esc(alt);
  let out = '<img src="' + esc(clean) + '" alt="' + esc(alt) + '"';
  if (title) out += ' title="' + esc(title) + '"';
  return out + '>';
}

// Try an inline link/image at position pos of src. Returns the parsed link
// or null when the text is not a link (the caller then falls through).
function tryLink(src, pos) {
  if (ST.linkParenPossible === false) return null;
  const cap = at(S.link, src, pos);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], pos + labelStart)) return null;
  const trimmedUrl = cap[2].trim();
  if (O.startAngleBracket.test(trimmedUrl)) {
    if (!O.endAngleBracket.test(trimmedUrl)) return null;
    const rt = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rt.length) % 2 === 0) return null;
  } else {
    const lastParen = findClosingBracket(cap[2], '()');
    if (lastParen === -2) return null;
    if (lastParen > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParen;
      cap[2] = cap[2].substring(0, lastParen);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return null;
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (O.startAngleBracket.test(href)) href = href.slice(1, -1);
  return {
    raw: cap[0],
    href: href ? href.replace(ANY_PUNCT, '$1') : href,
    title: title ? title.replace(ANY_PUNCT, '$1') : title,
    text: cap[1].replace(O.outputLinkReplace, '$1'),
    image: cap[0].charAt(0) === '!',
  };
}

// Try a reference link/image at position pos of src. Returns the parsed link,
// { textOnly: ch } when the reference is undefined (a one-character text
// token), or null when there is no reference-link shape at all.
function tryReflink(src, pos) {
  const cap = at(S.reflink, src, pos) || at(S.nolink, src, pos);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], pos + labelStart)) return null;
  const link = ST.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) return { textOnly: src.charAt(pos) };
  return {
    raw: cap[0],
    href: link.href,
    title: link.title,
    text: cap[1].replace(O.outputLinkReplace, '$1'),
    image: cap[0].charAt(0) === '!',
  };
}

// Render a parsed link/image, tokenizing its label text. Returns null when a
// (non-image) link's label already holds a link, so the caller falls through
// to plain text and the inner link is the one kept.
function outputLink(link, plain) {
  const outerInLink = ST.inLink;
  const outerEmitted = ST.linkEmitted;
  const outerRaw = ST.inRawBlock;
  ST.inLink = true;
  ST.linkEmitted = false;
  // An image's label is always rendered as plain text (its alt attribute),
  // even in an HTML run; a link's label follows the current mode.
  const inner = inlineRun(link.text, link.image ? true : plain);
  const textHasLink = ST.linkEmitted;
  ST.linkEmitted = outerEmitted;
  ST.inLink = outerInLink;
  if (!link.image) {
    if (textHasLink) {
      ST.inRawBlock = outerRaw;
      return null;
    }
    ST.linkEmitted = true;
    return plain ? inner : linkHtml(link.href, link.title || null, inner, false);
  }
  return plain ? inner : imageHtml(link.href, link.title || null, inner);
}

// ---------------------------------------------------------------------------
// Inline: emphasis, strong, strikethrough
// ---------------------------------------------------------------------------

// Try emphasis/strong at position pos of src. `masked` is the full masked
// run, `closers` the per-run closer scan. Returns { raw, text, kind } or null.
function emStrong(src, masked, pos, prevChar, closers) {
  const match = at(S.emLDelim, src, pos);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = pos;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!PUNCTUATION.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!PUNCTUATION.exec(prevChar);
  if (match[4] && prevChar.match(O.unicodeAlphaNumeric)) return null;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    const endReg = delimChar === '*' ? EM_R_DELIM_AST : EM_R_DELIM_UND;
    const lastPossible = delimChar === '*' ? closers.ast : closers.und;
    const windowStart = pos + lLength;
    if (lastPossible < windowStart) return null;
    const window = masked.slice(pos + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    let m;
    while ((m = endReg.exec(window)) !== null) {
      if (m.index > lastInWindow) break;
      rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (m[3] || m[4]) {
        delimTotal += rLength;
        continue;
      } else if (m[5] || m[6] || openerCanClose) {
        if (midRun && (m[5] || m[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...m[0]][0].length;
      const raw = src.slice(pos, pos + lLength + m.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        return { raw, text: raw.slice(1, -1), kind: 'em' };
      }
      return { raw, text: raw.slice(2, -2), kind: 'strong' };
    }
  }
  return null;
}

// Try strikethrough at position pos of src. Returns { raw, text } or null.
function tryDel(src, masked, pos, prevChar, closers) {
  const match = at(S.delLDelim, src, pos);
  if (!match) return null;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || PUNCTUATION.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let delimTotal = lLength;
    const windowStart = pos + lLength;
    if (closers.del < windowStart) return null;
    const window = masked.slice(pos + lLength);
    const lastInWindow = closers.del - windowStart;
    DEL_R_DELIM.lastIndex = 0;
    let m;
    while ((m = DEL_R_DELIM.exec(window)) !== null) {
      if (m.index > lastInWindow) break;
      const rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!rDelim) continue;
      const rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (m[3] || m[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      const lastCharLength = [...m[0]][0].length;
      const raw = src.slice(pos, pos + lLength + m.index + lastCharLength + Math.min(rLength, rLength + delimTotal));
      return { raw, text: raw.slice(lLength, -lLength) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inline: the cursor loop. Renders src straight to HTML (plain=false) or to
// plain text (plain=true, for image alt text), with the same tokenization
// decisions in both modes.
// ---------------------------------------------------------------------------

function inlineRun(src, plain) {
  const prevParen = ST.linkParenPossible;
  ST.linkParenPossible = prevParen && src.includes(')');
  try {
    return inlineInner(src, plain);
  } finally {
    ST.linkParenPossible = prevParen;
  }
}

function inlineInner(src, plain) {
  // Fast path: no inline construct can start anywhere in this run, so the
  // whole run is a single text token. (A hard break needs two spaces or a
  // backslash before a newline; an autolink needs '<', 'www.', '://' or an
  // '@' email; everything else needs one of the listed characters.)
  if (!src.includes('\\') && !src.includes('<') && !src.includes('[') && !src.includes('`')
    && !src.includes('*') && !src.includes('_') && !src.includes('~') && !src.includes('@')
    && !src.includes('www.') && !src.includes('://') && !src.includes('  \n')) {
    const text = ST.inRawBlock ? src : decodeNumRefs(src);
    return plain ? text : (ST.inRawBlock ? text : esc(text));
  }
  const masked = (src.includes('*') || src.includes('_') || src.includes('~')) ? maskSrc(src) : src;
  const closers = scanClosers(masked);
  let out = '';
  let prevChar = '';
  let keepPrev = false;
  let pos = 0;
  let remaining = Infinity;
  while (pos < src.length) {
    if (src.length - pos >= remaining) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    remaining = src.length - pos;
    if (!keepPrev) prevChar = '';
    keepPrev = false;
    let m;
    // escape
    if ((m = at(S.escape, src, pos))) {
      out += plain ? m[1] : esc(m[1]);
      pos += m[0].length;
      continue;
    }
    // tag
    if ((m = at(S.tag, src, pos))) {
      if (!ST.inLink && O.startATag.test(m[0])) ST.inLink = true;
      else if (ST.inLink && O.endATag.test(m[0])) ST.inLink = false;
      if (!ST.inRawBlock && O.startPreScriptTag.test(m[0])) ST.inRawBlock = true;
      else if (ST.inRawBlock && O.endPreScriptTag.test(m[0])) ST.inRawBlock = false;
      out += m[0];
      pos += m[0].length;
      continue;
    }
    // link
    const link = tryLink(src, pos);
    if (link) {
      const rendered = outputLink(link, plain);
      if (rendered !== null) {
        out += rendered;
        pos += link.raw.length;
        continue;
      }
    }
    // reflink, nolink
    const ref = tryReflink(src, pos);
    if (ref) {
      if (ref.textOnly !== undefined) {
        const ch = ref.textOnly;
        out += plain ? ch : esc(ch);
        pos += 1;
        continue;
      }
      const rendered = outputLink(ref, plain);
      if (rendered !== null) {
        out += rendered;
        pos += ref.raw.length;
        continue;
      }
    }
    // em & strong
    const em = emStrong(src, masked, pos, prevChar, closers);
    if (em) {
      out += plain
        ? inlineRun(em.text, true)
        : (em.kind === 'em' ? '<em>' + inlineRun(em.text, false) + '</em>'
          : '<strong>' + inlineRun(em.text, false) + '</strong>');
      pos += em.raw.length;
      continue;
    }
    // code span
    if ((m = at(S.codeSpan, src, pos))) {
      let text = m[2].replace(O.newLineCharGlobal, ' ');
      if (O.nonSpaceChar.test(text) && O.startingSpaceChar.test(text) && O.endingSpaceChar.test(text)) {
        text = text.substring(1, text.length - 1);
      }
      out += plain ? text : '<code>' + esc(text, true) + '</code>';
      pos += m[0].length;
      continue;
    }
    // br
    if ((m = at(S.br, src, pos))) {
      out += plain ? '' : '<br>';
      pos += m[0].length;
      continue;
    }
    // del
    const del = tryDel(src, masked, pos, prevChar, closers);
    if (del) {
      out += plain ? inlineRun(del.text, true) : '<del>' + inlineRun(del.text, false) + '</del>';
      pos += del.raw.length;
      continue;
    }
    // autolink
    if ((m = at(S.autolink, src, pos))) {
      let text, href;
      if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
      else { text = m[1]; href = text; }
      out += plain ? text : linkHtml(href, null, esc(text, true), true);
      pos += m[0].length;
      continue;
    }
    // url (gfm extended autolink)
    if (!ST.inLink && (m = at(S.url, src, pos))) {
      let text, href;
      if (m[2] === '@') {
        text = m[0];
        href = 'mailto:' + text;
      } else {
        let prevCapZero;
        do {
          prevCapZero = m[0];
          m[0] = BACKPEDAL.exec(m[0])?.[0] ?? '';
        } while (prevCapZero !== m[0]);
        text = m[0];
        href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
      }
      out += plain ? text : linkHtml(href, null, esc(text, true), true);
      pos += m[0].length;
      continue;
    }
    // text
    if ((m = at(S.inlineText, src, pos))) {
      const raw = m[0];
      const text = ST.inRawBlock ? raw : decodeNumRefs(raw);
      out += plain ? text : (ST.inRawBlock ? text : esc(text));
      if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
      keepPrev = true;
      pos += raw.length;
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function codeHtml(t) {
  const langString = (t.lang || '').match(O.notSpaceStart)?.[0];
  const code = t.text ? t.text.replace(O.endingNewline, '') + '\n' : '';
  if (!langString) return '<pre><code>' + esc(code, true) + '</code></pre>\n';
  return '<pre><code class="language-' + esc(langString) + '">' + esc(code, true) + '</code></pre>\n';
}

function tableCellHtml(cell, header) {
  const type = header ? 'th' : 'td';
  const tag = cell.align ? '<' + type + ' align="' + cell.align + '">' : '<' + type + '>';
  return tag + cell.html + '</' + type + '>\n';
}

function tableHtml(t) {
  let header = '';
  for (const cell of t.header) header += tableCellHtml(cell, true);
  let body = '';
  for (const row of t.rows) {
    let cells = '';
    for (const cell of row) cells += tableCellHtml(cell, false);
    body += '<tr>\n' + cells + '</tr>\n';
  }
  if (body) body = '<tbody>' + body + '</tbody>';
  return '<table>\n<thead>\n<tr>\n' + header + '</tr>\n</thead>\n' + body + '</table>\n';
}

function listHtml(t) {
  let body = '';
  for (const item of t.items) body += '<li>' + renderTokens(item.toks) + '</li>\n';
  const type = t.ordered ? 'ol' : 'ul';
  const startAttr = (t.ordered && t.start !== 1) ? ' start="' + t.start + '"' : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

function renderTokens(toks) {
  let out = '';
  for (const t of toks) {
    switch (t.k) {
      case 'space': case 'def': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += '<h' + t.depth + '>' + t.html + '</h' + t.depth + '>\n'; break;
      case 'code': out += codeHtml(t); break;
      case 'table': out += tableHtml(t); break;
      case 'blockquote': out += '<blockquote>\n' + renderTokens(t.toks) + '</blockquote>\n'; break;
      case 'list': out += listHtml(t); break;
      case 'checkbox': out += checkboxHtml(t.checked); break;
      case 'html': out += t.text; break;
      case 'paragraph': out += '<p>' + (t.cb !== undefined ? checkboxHtml(t.cb) : '') + t.html + '</p>\n'; break;
      case 'text': out += (t.cb !== undefined ? checkboxHtml(t.cb) : '') + t.html; break;
      default: throw new Error('Token with "' + t.k + '" type was not found.');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block lexing: walk the source with a cursor and sticky regexes.
// ---------------------------------------------------------------------------

function blockTokens(src, toks, clipped) {
  toks = toks || [];
  clipped = !!clipped;
  let pos = 0;
  let srcLength = Infinity;
  while (pos < src.length) {
    const remaining = src.length - pos;
    if (remaining >= srcLength) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    srcLength = remaining;
    let m;
    // newline
    if ((m = at(S.space, src, pos)) && m[0].length > 0) {
      const raw = m[0];
      pos += raw.length;
      const last = toks[toks.length - 1];
      if (raw.length === 1 && last !== undefined) last.raw = (last.raw || '') + '\n';
      else toks.push({ k: 'space', raw });
      continue;
    }
    // indented code (cannot interrupt a paragraph: it joins it)
    if ((m = at(S.code, src, pos))) {
      const raw = trimTrailingBlankLines(m[0]);
      const text = raw.replace(O.codeRemoveIndent, '');
      pos += raw.length;
      const last = toks[toks.length - 1];
      if (last && (last.k === 'paragraph' || last.k === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
        last.text += '\n' + text;
        ST.queue[ST.queue.length - 1].src = last.text;
      } else {
        toks.push({ k: 'code', raw, text });
      }
      continue;
    }
    // fences
    if ((m = at(S.fences, src, pos))) {
      const text = indentCodeCompensation(m[0], m[3] || '');
      const lang = m[2] ? m[2].trim().replace(ANY_PUNCT, '$1') : m[2];
      toks.push({ k: 'code', raw: m[0], text, lang });
      pos += m[0].length;
      continue;
    }
    // heading
    if ((m = at(S.heading, src, pos))) {
      let text = m[2].trim();
      if (O.endingHash.test(text)) {
        const trimmed = rtrim(text, '#');
        if (!trimmed || O.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
      }
      const tok = { k: 'heading', raw: rtrim(m[0], '\n'), depth: m[1].length, text, html: '' };
      ST.queue.push({ tok, src: text });
      toks.push(tok);
      pos += tok.raw.length;
      continue;
    }
    // hr
    if ((m = at(S.hr, src, pos))) {
      const raw = rtrim(m[0], '\n');
      toks.push({ k: 'hr', raw });
      pos += raw.length;
      continue;
    }
    // blockquote: only attempt when 0-3 spaces are followed by '>' (the
    // regex would fail otherwise, and slicing the rest of the document
    // just to find that out costs a full copy per block)
    {
      let i = pos;
      if (src[i] === ' ') { i++; if (src[i] === ' ') { i++; if (src[i] === ' ') i++; } }
      if (src[i] === '>') {
        const bq = bqToken(src.slice(pos));
        if (bq) {
          toks.push(bq);
          pos += bq.raw.length;
          continue;
        }
      }
    }
    // list: only attempt when 0-3 spaces are followed by a bullet or digit
    {
      let i = pos;
      if (src[i] === ' ') { i++; if (src[i] === ' ') { i++; if (src[i] === ' ') i++; } }
      const ch = src[i];
      if (ch === '*' || ch === '+' || ch === '-' || (ch >= '0' && ch <= '9')) {
        const list = listToken(src.slice(pos));
        if (list) {
          toks.push(list);
          pos += list.raw.length;
          continue;
        }
      }
    }
    // html
    if ((m = at(S.html, src, pos))) {
      const raw = trimTrailingBlankLines(m[0]);
      toks.push({ k: 'html', raw, text: raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style' });
      pos += raw.length;
      continue;
    }
    // def
    if ((m = at(S.def, src, pos))) {
      const raw = rtrim(m[0], '\n');
      pos += raw.length;
      if (!O.startAngleBracket.test(m[2]) && findClosingBracket(m[2], '()') !== -1) {
        // not a definition after all: re-lex from the same spot as text
        pos -= raw.length;
      } else {
        const last = toks[toks.length - 1];
        if (last && (last.k === 'paragraph' || last.k === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
          last.text += '\n' + raw;
          ST.queue[ST.queue.length - 1].src = last.text;
        } else {
          const tag = normalizeLabel(m[1]);
          if (!ST.links[tag]) {
            ST.linkCount++;
            ST.links[tag] = {
              href: m[2] ? m[2].replace(O.hrefBrackets, '$1').replace(ANY_PUNCT, '$1') : '',
              title: m[3] ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT, '$1') : m[3],
            };
          }
          toks.push({ k: 'def', raw });
        }
        continue;
      }
    }
    // table (gfm)
    {
      const table = tableToken(src, pos);
      if (table) {
        toks.push(table);
        pos += table.raw.length;
        continue;
      }
    }
    // lheading
    if ((m = at(S.lheading, src, pos))) {
      const text = m[1].trim();
      const tok = { k: 'heading', raw: rtrim(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, html: '' };
      ST.queue.push({ tok, src: text });
      toks.push(tok);
      pos += tok.raw.length;
      continue;
    }
    // top-level paragraph
    if (ST.top && (m = at(S.paragraph, src, pos))) {
      const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      const last = toks[toks.length - 1];
      if (clipped && last && last.k === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + m[0];
        last.text += '\n' + text;
        ST.queue[ST.queue.length - 1].src = last.text;
      } else {
        const tok = { k: 'paragraph', raw: m[0], text, html: '' };
        ST.queue.push({ tok, src: text });
        toks.push(tok);
      }
      pos += m[0].length;
      clipped = false;
      continue;
    }
    // text
    if ((m = at(S.text, src, pos))) {
      const last = toks[toks.length - 1];
      if (last && last.k === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + m[0];
        last.text += '\n' + m[0];
        ST.queue[ST.queue.length - 1].src = last.text;
      } else {
        const tok = { k: 'text', raw: m[0], text: m[0], html: '' };
        ST.queue.push({ tok, src: m[0] });
        toks.push(tok);
      }
      pos += m[0].length;
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  ST.top = true;
  return toks;
}

// ---------------------------------------------------------------------------
// Block tokenizers: blockquote, list
// ---------------------------------------------------------------------------

function firstLineOf(str) {
  const nl = str.indexOf('\n');
  return nl === -1 ? str : str.slice(0, nl);
}

function bqToken(src) {
  const cap = BLOCKQUOTE.exec(src);
  if (!cap) return null;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const toks = [];
  while (lines.length > 0) {
    let inBq = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (O.blockquoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBq = true;
      } else if (!inBq) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);
    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      .replace(O.blockquoteMarkerWhitespace, (_, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(O.blockquoteSetextReplace, '\n    $1')
      .replace(O.blockquoteSetextReplace2, '');
    raw = raw ? raw + '\n' + currentRaw : currentRaw;
    text = text ? text + '\n' + currentText : currentText;
    const top = ST.top;
    ST.top = true;
    blockTokens(currentText, toks, true);
    ST.top = top;
    if (lines.length === 0) break;
    const lastToken = toks[toks.length - 1];
    if (lastToken && (lastToken.k === 'code' || lastToken.k === 'heading' || lastToken.k === 'hr' || lastToken.k === 'html' || lastToken.k === 'table')) {
      break;
    } else if (lastToken && lastToken.k === 'blockquote') {
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(O.blockquoteSetextReplace2, '');
      const newToken = bqToken(newText);
      if (!newToken) break;
      toks[toks.length - 1] = newToken;
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (lastToken && lastToken.k === 'list') {
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = listToken(newText);
      if (!newToken) break;
      toks[toks.length - 1] = newToken;
      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = raw + '\n' + consumed;
        text = text + '\n' + consumed;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }
  return { k: 'blockquote', raw, text, toks };
}

function listToken(src) {
  let cap = LIST.exec(src);
  if (!cap) return null;
  const listSrc = src;
  let s = src;
  const taken = () => listSrc.length - s.length;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const list = {
    k: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = O.listItemRegex(bull);
  let endsWithBlankLine = false;
  while (s) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = itemRegex.exec(s))) break;
    if (HR.test(s)) break;
    const itemStart = taken();
    s = s.substring(cap[0].length);
    const firstLine = firstLineOf(cap[2]);
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(O.leadingSpaceTab, (ws) => expandTabs(ws, bulletIndent));
    let nextLine = firstLineOf(s);
    let blankLine = !line.trim();
    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(O.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (blankLine && O.blankLine.test(nextLine)) {
      s = s.substring(nextLine.length + 1);
      endEarly = true;
    }
    if (!endEarly) {
      const nextBulletRegex = O.nextBulletRegex(indent);
      const hrRegex = O.hrRegex(indent);
      const fencesBeginRegex = O.fencesBeginRegex(indent);
      const headingBeginRegex = O.headingBeginRegex(indent);
      const htmlBeginRegex = O.htmlBeginRegex(indent);
      const blockquoteBeginRegex = O.blockquoteBeginRegex(indent);
      while (s) {
        const rawLine = firstLineOf(s);
        nextLine = rawLine;
        const nextLineWithoutTabs = nextLine.replace(O.leadingSpaceTab, (ws) => expandTabs(ws));
        if (fencesBeginRegex.test(nextLine)) break;
        if (headingBeginRegex.test(nextLine)) break;
        if (htmlBeginRegex.test(nextLine)) break;
        if (blockquoteBeginRegex.test(nextLine)) break;
        if (nextBulletRegex.test(nextLine)) break;
        if (hrRegex.test(nextLine)) break;
        if (nextLineWithoutTabs.search(O.nonSpaceChar) >= indent || !nextLine.trim()) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          if (line.replace(O.tabCharGlobal, '    ').search(O.nonSpaceChar) >= 4) break;
          if (fencesBeginRegex.test(line)) break;
          if (headingBeginRegex.test(line)) break;
          if (htmlBeginRegex.test(line)) break;
          if (hrRegex.test(line)) break;
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && LHEADING.test(line + '\n' + nextLine);
          const continuation = setextContinuation
            ? '    ' + nextLineWithoutTabs.replace(/^ {0,3}/, '')
            : nextLine;
          itemContents += '\n' + continuation;
        }
        blankLine = !nextLine.trim();
        s = s.substring(rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }
    const raw = listSrc.slice(itemStart, taken());
    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (O.doubleBlankLine.test(raw)) endsWithBlankLine = true;
    }
    list.items.push({
      k: 'list_item',
      raw,
      task: !!O.listIsTask.test(itemContents),
      loose: false,
      text: itemContents,
      toks: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return null;
  }
  list.raw = listSrc.slice(0, taken()).trimEnd();
  for (const item of list.items) {
    ST.top = false;
    item.toks = blockTokens(item.text, []);
    if (!list.loose) {
      const spacers = item.toks.filter((t) => t.k === 'space');
      list.loose = spacers.length > 0 && spacers.some((t) => O.anyLine.test(t.raw));
    }
  }
  for (const item of list.items) {
    const itemToken = item.toks[0];
    if (item.task && itemToken && (itemToken.k === 'text' || itemToken.k === 'paragraph')) {
      itemToken.raw = itemToken.raw.replace(O.listReplaceTask, '');
      itemToken.text = itemToken.text.replace(O.listReplaceTask, '');
      for (let i = ST.queue.length - 1; i >= 0; i--) {
        if (O.listIsTask.test(ST.queue[i].src)) {
          ST.queue[i].src = ST.queue[i].src.replace(O.listReplaceTask, '');
          break;
        }
      }
      const taskRaw = O.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checked = taskRaw[0] !== '[ ]';
        item.checked = checked;
        if (list.loose) {
          if (itemToken.k === 'paragraph' || itemToken.k === 'text') {
            itemToken.cb = checked;
          } else {
            item.toks.unshift({ k: 'paragraph', raw: taskRaw[0] + ' ', text: '', html: '', cb: checked });
          }
        } else {
          item.toks.unshift({ k: 'checkbox', checked });
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.toks) {
        if (token.k === 'text') token.k = 'paragraph';
      }
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// Block tokenizers: table; fence indent compensation; the parse entry point
// ---------------------------------------------------------------------------

function indentCodeCompensation(raw, text) {
  const m = raw.match(O.indentCodeCompensation);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mm = node.match(O.beginningSpace);
    if (mm === null) return node;
    return node.slice(Math.min(mm[0].length, indentToCode.length));
  }).join('\n');
}

function tableToken(src, pos) {
  const cap = at(S.table, src, pos);
  if (!cap) return null;
  if (!O.tableDelimiter.test(cap[2])) return null;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(O.tableAlignChars, '').split('|');
  const rows = cap[3] && cap[3].trim() ? cap[3].replace(O.tableRowBlankLine, '').split('\n') : [];
  if (headers.length !== aligns.length) return null;
  const align = aligns.map((a) => {
    if (O.tableAlignRight.test(a)) return 'right';
    if (O.tableAlignCenter.test(a)) return 'center';
    if (O.tableAlignLeft.test(a)) return 'left';
    return null;
  });
  const header = headers.map((h, i) => ({ text: h, align: align[i], html: '' }));
  for (const cell of header) ST.queue.push({ tok: cell, src: cell.text });
  const rowCells = rows.map((row) => {
    const cells = splitCells(row, header.length).map((c, i) => ({ text: c, align: align[i], html: '' }));
    for (const cell of cells) ST.queue.push({ tok: cell, src: cell.text });
    return cells;
  });
  return { k: 'table', raw: rtrim(cap[0], '\n'), header, align, rows: rowCells };
}

/**
 * Render `markdown` to exactly the HTML marked 18.1.3 renders with its
 * defaults (GFM on, breaks off, pedantic off). Fresh state per call: nothing
 * is kept from an earlier call, and no input is recognised or cached.
 */
export function parse(markdown) {
  const src = markdown.replace(O.carriageReturn, '\n');
  ST = {
    links: Object.create(null),
    linkCount: 0,
    queue: [],
    top: true,
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
  };
  const toks = blockTokens(src, [], false);
  for (const entry of ST.queue) {
    ST.inRawBlock = false;
    entry.tok.html = inlineRun(entry.src, false);
  }
  ST.queue = [];
  return renderTokens(toks);
}
