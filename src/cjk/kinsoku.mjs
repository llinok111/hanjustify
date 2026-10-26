/**
 * Kinsoku (禁则 / 避头尾) rules for Chinese text, expressed as data.
 *
 * Sources for the character classes:
 *   - W3C "Requirements for Chinese Text Layout" (clreq), §5.1 标点符号
 *     https://www.w3.org/TR/clreq/
 *   - GB/T 15834—2011《标点符号用法》 for the punctuation inventory itself
 *
 * The two rules that matter for line breaking:
 *   行首禁则 (line-start prohibition): a character in LINE_START_FORBIDDEN must
 *     not be placed at the beginning of a line. Implemented by refusing to create
 *     a break opportunity immediately *before* such a character.
 *   行尾禁则 (line-end prohibition): a character in LINE_END_FORBIDDEN must not be
 *     placed at the end of a line. Implemented by refusing to create a break
 *     opportunity immediately *after* such a character.
 *
 * Scope note: this module only encodes the *character classes*. Priority
 * between the two rules, and the fallback when a line cannot be set without
 * violating both, is decided in segment.mjs so it stays testable in isolation.
 */

/** Ranges that carry an ideographic (advance-width-driven) break model. */
const CJK_RANGES = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x2eff], // CJK Radicals Supplement
  [0x3000, 0x303f], // CJK Symbols and Punctuation
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30ff], // Katakana
  [0x3100, 0x312f], // Bopomofo
  [0x3130, 0x318f], // Hangul Compatibility Jamo
  [0x3190, 0x319f], // Kanbun
  [0x31c0, 0x31ef], // CJK Strokes
  [0x3200, 0x32ff], // Enclosed CJK Letters and Months
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe1f], // Vertical Forms
  [0xfe30, 0xfe4f], // CJK Compatibility Forms
  [0xff00, 0xffef], // Halfwidth and Fullwidth Forms
  [0x20000, 0x2a6df], // CJK Unified Ideographs Extension B
  [0x2a700, 0x2ebef], // CJK Unified Ideographs Extension C-F
  [0x2f800, 0x2fa1f], // CJK Compatibility Ideographs Supplement
];

/**
 * Punctuation that lives in the General Punctuation block but behaves as CJK
 * text: curly quotes, the em/en dash, the ellipsis, the two-em dash and the
 * middle dot. These are *not* covered by CJK_RANGES, and treating them as Latin
 * is a visible bug rather than a cosmetic one -- the Han↔Latin gap rule then
 * injects a spurious 1/4 em on both sides of every `“ ” —— ……`, and the tokenizer
 * stops folding them into the surrounding run.
 */
const CJK_ADJACENT_PUNCTUATION = new Set([
  0x2014, // — em dash
  0x2013, // – en dash
  0x2018, 0x2019, // ‘ ’
  0x201c, 0x201d, // “ ”
  0x201e, // „
  0x2026, // … horizontal ellipsis
  0x2027, // ‧ hyphenation point
  0x00b7, // · middle dot (clreq §5.1 第9项)
  0x2e3a, // ⸺ two-em dash (clreq §5.1 第6项 recommends this code point)
  0x30fb, // ・ katakana middle dot
]);

/** Full-width forms that should be measured as one ideographic em. */
const FULLWIDTH_RANGES = [
  [0x3000, 0x303f],
  [0xfe10, 0xfe1f],
  [0xfe30, 0xfe4f],
  [0xff01, 0xff60], // fullwidth ASCII variants
  [0xffe0, 0xffe6], // fullwidth signs
];

function inRanges(cp, ranges) {
  for (let i = 0; i < ranges.length; i++) {
    if (cp >= ranges[i][0] && cp <= ranges[i][1]) return true;
  }
  return false;
}

export const isCJK = cp => inRanges(cp, CJK_RANGES);
export const isFullWidth = cp => inRanges(cp, FULLWIDTH_RANGES);

/**
 * True when the code point belongs to the CJK text model, either because it is
 * in an ideographic range or because it is CJK-adjacent punctuation.
 * Use this -- not `isCJK` -- for tokenizing and for the script-gap decision.
 */
export const isCJKText = cp => isCJK(cp) || CJK_ADJACENT_PUNCTUATION.has(cp);

/**
 * 行首禁则 — must never start a line.
 *
 * Closing brackets, sentence/stop punctuation, and trailing marks. The list is the
 * intersection of clreq §5.1 and GB/T 15834 closing classes; it deliberately
 * excludes the opening quotation marks, which belong to the line-*end* set instead.
 *
 * `—` and `…` are included as the standard 避头尾 treatment of the dash and the
 * ellipsis: clreq §5.1 第6项 requires a two-em dash not to be *split* across lines
 * (handled by UNSPLITTABLE_SEQUENCES below), and the conventional kinsoku table
 * additionally keeps those marks with the text they follow rather than letting
 * them open a line. Without the entry, UAX#14 -- which reports a legal break
 * immediately before `——` (measured: `他说——不行` -> positions [1,2,4,5]) -- would
 * let a line begin with a dash.
 */
export const LINE_START_FORBIDDEN = new Set([
  // Fullwidth CJK punctuation
  '、', '。', '，', '．', '；', '：', '？', '！',
  '）', '〕', '〉', '》', '」', '』', '】', '〗', '〙', '〛',
  '”', '’', '％', '‰', '℃', '°', '′', '″', '·', '～',
  '—', '…',
  // The halfwidth/fullwidth ASCII variants that the line breaker may see
  ')', ']', '}', ',', '.', ';', ':', '?', '!', '%',
]);

/**
 * 行尾禁则 — must never end a line.
 *
 * Opening brackets and opening quotation marks. Breaking after these leaves an
 * opening mark dangling at the right margin, which clreq forbids.
 */
export const LINE_END_FORBIDDEN = new Set([
  '（', '〔', '〈', '《', '「', '『', '【', '〖', '〘', '〚',
  '“', '‘', '＄', '￥', '＃', '＠',
  '(', '[', '{', '$',
]);

/**
 * Punctuation that occupies a full ideographic em but whose ink sits on one
 * side of the em box, so the surrounding blank may be compressed at the margin.
 * clreq §5.1.1.1: 大陆式点号位于字面左下角，行末可压缩至半角。
 *
 * These get a half-em normal width plus a half-em shrinkable glue, so the
 * Knuth-Plass engine can absorb them when a line would otherwise be loose.
 */
export const COMPRESSIBLE_PUNCTUATION = new Set([
  '，', '。', '、', '；', '：', '！', '？',
]);

/**
 * Punctuation that must never be split across a line even though the
 * underlying break algorithm offers an opportunity. clreq §5.1 第6项 explicitly
 * names the two-em dash; the ellipsis is the same case by convention.
 */
export const UNSPLITTABLE_SEQUENCES = ['——', '……'];

/** Marks whose repetition may not be broken between the two glyphs. */
export function isUnsplittablePair(a, b) {
  return UNSPLITTABLE_SEQUENCES.includes(a + b);
}

/**
 * clreq §2.1.3 第2项: the gap inserted between Han and Western text must not
 * exceed 1/4 em, and no gap is inserted when the Western run sits at the line
 * edge. Expressed as a fraction of the font size.
 */
export const CJK_LATIN_GAP_EM = 0.25;

/** Default inter-character stretch for Han text, as a fraction of the em. */
export const DEFAULT_CJK_STRETCH_EM = 0.05;

export const __internal = { CJK_RANGES, FULLWIDTH_RANGES, inRanges };
