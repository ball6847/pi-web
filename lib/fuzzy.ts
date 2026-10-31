/**
 * Tiered fuzzy matching for the Quick Open palette.
 *
 * A plain "contains" match asks the user to know the exact string; a plain
 * subsequence match over prose is noise ("abc" matches "a big cat"). So every
 * query is scored into a tier, and the tier decides the order: an exact title
 * first, a scattered subsequence last. Each tier keeps the indices it matched,
 * so a row can show *why* it is in the list.
 *
 * The ladder, from the best match to the worst:
 *   exact      the whole text is the query
 *   prefix     the text starts with the query
 *   word       the query starts at a word boundary or a camelCase hump
 *   substring  the query appears in one unbroken run
 *   subsequence the query's letters appear in order, gaps allowed
 *   typo       one edit away from a word of the text
 *
 * Pure and client-safe: no DOM, no server, no clock.
 */

export type FuzzyTier = "exact" | "prefix" | "word" | "substring" | "subsequence" | "typo";

export interface FuzzyMatch {
  /** How well the query matched: higher is better, only meaningful inside one tier. */
  score: number;
  /** The tier the match landed in. */
  tier: FuzzyTier;
  /** Indices in the searched text the query matched, ascending. */
  positions: number[];
}

/** The score each tier starts at. A tier is a range, not a point: the bonuses below move a match inside it. */
export const FUZZY_TIER_SCORE: Record<FuzzyTier, number> = {
  exact: 1000,
  prefix: 900,
  word: 800,
  substring: 700,
  subsequence: 500,
  typo: 300,
};

/** The tiers from the best to the worst; the rank is what orders two matches. */
export const FUZZY_TIER_ORDER: readonly FuzzyTier[] = ["exact", "prefix", "word", "substring", "subsequence", "typo"];

/** The rank of a tier: the smaller, the better. */
export function fuzzyTierRank(tier: FuzzyTier): number {
  const index = FUZZY_TIER_ORDER.indexOf(tier);
  return index === -1 ? FUZZY_TIER_ORDER.length : index;
}

/** A camelCase hump: an upper-case letter right after a lower-case one. */
function isCamelHump(text: string, index: number): boolean {
  if (index <= 0) return false;
  const current = text.charCodeAt(index);
  const previous = text.charCodeAt(index - 1);
  return current >= 65 && current <= 90 && previous >= 97 && previous <= 122;
}

/** A word boundary: the start of the text, or a character that is not a letter or a digit. */
function isWordBoundary(text: string, index: number): boolean {
  if (index <= 0) return true;
  const code = text.charCodeAt(index - 1);
  const isAlphanumeric = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  return !isAlphanumeric;
}

function range(start: number, length: number): number[] {
  const positions: number[] = [];
  for (let i = 0; i < length; i++) positions.push(start + i);
  return positions;
}

/**
 * Whether two strings are one edit apart (a substitution, an insertion or a
 * deletion). A typo tier, not a spelling correction: "sesion" finds "session".
 */
export function isOneEditApart(a: string, b: string): boolean {
  if (a === b) return false;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (long.length - short.length > 1) return false;
  let shortIndex = 0;
  let longIndex = 0;
  let edits = 0;
  while (shortIndex < short.length && longIndex < long.length) {
    if (short[shortIndex] === long[longIndex]) {
      shortIndex++;
      longIndex++;
      continue;
    }
    edits++;
    if (edits > 1) return false;
    if (long.length === short.length) {
      // A substitution: the longer word is not longer, so both sides move.
      shortIndex++;
      longIndex++;
    } else {
      // An insertion in the longer word: only it moves.
      longIndex++;
    }
  }
  if (shortIndex < short.length || longIndex < long.length) edits++;
  return edits <= 1;
}

interface SubsequenceCandidate {
  positions: number[];
  /** How many of the matched characters sit on a camelCase hump. */
  humps: number;
  /** How many sit on a word boundary or a camelCase hump. */
  starts: number;
  /** The last index minus the first: how far apart the match is spread. */
  span: number;
}

/**
 * The query's letters in order, gaps allowed.
 *
 * Two candidates are built and the better one wins: the greedy one (the
 * earliest letter each time) and the one that prefers word boundaries and
 * camelCase humps ("kb" of "KanbanBoard"). More humps win; a tie goes to the
 * more compact match.
 */
function subsequenceCandidates(term: string, lowerText: string, text: string): SubsequenceCandidate[] {
  const candidates: SubsequenceCandidate[] = [];
  for (const preferBoundaries of [false, true]) {
    const positions: number[] = [];
    let textIndex = 0;
    let humps = 0;
    let starts = 0;
    let ok = true;
    for (let termIndex = 0; termIndex < term.length; termIndex++) {
      let found = -1;
      if (preferBoundaries) {
        for (let j = textIndex; j < lowerText.length; j++) {
          if (lowerText[j] === term[termIndex] && (isWordBoundary(text, j) || isCamelHump(text, j))) {
            found = j;
            break;
          }
        }
      }
      if (found === -1) {
        for (let j = textIndex; j < lowerText.length; j++) {
          if (lowerText[j] === term[termIndex]) {
            found = j;
            break;
          }
        }
      }
      if (found === -1) {
        ok = false;
        break;
      }
      positions.push(found);
      if (isCamelHump(text, found)) humps++;
      if (isWordBoundary(text, found) || isCamelHump(text, found)) starts++;
      textIndex = found + 1;
    }
    if (!ok || !positions.length) continue;
    candidates.push({ positions, humps, starts, span: positions[positions.length - 1] - positions[0] });
  }
  return candidates;
}

/** The best subsequence match of the term in the text, or null. */
function subsequenceMatch(term: string, lowerText: string, text: string): FuzzyMatch | null {
  const candidates = subsequenceCandidates(term, lowerText, text);
  if (!candidates.length) return null;
  let best = candidates[0];
  for (const candidate of candidates) {
    if (candidate.humps > best.humps || (candidate.humps === best.humps && candidate.span < best.span)) {
      best = candidate;
    }
  }
  let score = FUZZY_TIER_SCORE.subsequence;
  let previous = -2;
  for (const position of best.positions) {
    if (isWordBoundary(text, position) || isCamelHump(text, position)) score += 40;
    if (position === previous + 1) score += 25;
    else score -= Math.min(position - previous - 1, 20);
    previous = position;
  }
  // A long text with the same letters in it is a weaker match than a short one.
  score -= Math.min(Math.max(lowerText.length - term.length, 0), 60) * 0.5;
  if (best.humps >= 1 && best.starts >= 2) {
    // CamelCase initials ("kb" of "KanbanBoard"): a word match, but a loose
    // one. Prose is not promoted: its word-initial capitals would turn every
    // scattered match into a word match.
    return { score: Math.max(score, FUZZY_TIER_SCORE.word - 20), tier: "word", positions: best.positions };
  }
  return { score, tier: "subsequence", positions: best.positions };
}

/** A word of the text one edit away from the term. */
function typoMatch(term: string, lowerText: string): FuzzyMatch | null {
  if (term.length < 3) return null;
  let wordStart = -1;
  for (let index = 0; index <= lowerText.length; index++) {
    const atEnd = index === lowerText.length;
    const code = atEnd ? 0 : lowerText.charCodeAt(index);
    const isAlphanumeric = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (atEnd || !isAlphanumeric) {
      if (wordStart !== -1) {
        const word = lowerText.slice(wordStart, index);
        if (word.length >= 3 && isOneEditApart(term, word)) {
          return { score: FUZZY_TIER_SCORE.typo, tier: "typo", positions: range(wordStart, word.length) };
        }
      }
      wordStart = index + 1;
    }
  }
  return null;
}

/**
 * One term against one text. Null when the term is nowhere in it.
 */
export function fuzzyMatchTerm(term: string, text: string): FuzzyMatch | null {
  const trimmed = term.trim();
  if (!trimmed || !text) return null;
  const lowerTerm = trimmed.toLowerCase();
  const lowerText = text.toLowerCase();
  if (lowerText === lowerTerm) return { score: FUZZY_TIER_SCORE.exact, tier: "exact", positions: range(0, text.length) };
  if (lowerText.startsWith(lowerTerm)) return { score: FUZZY_TIER_SCORE.prefix, tier: "prefix", positions: range(0, trimmed.length) };

  let hit = lowerText.indexOf(lowerTerm);
  let wordHit = -1;
  let plainHit = -1;
  while (hit !== -1) {
    if (isWordBoundary(text, hit) || isCamelHump(text, hit)) {
      wordHit = hit;
      break;
    }
    if (plainHit === -1) plainHit = hit;
    hit = lowerText.indexOf(lowerTerm, hit + 1);
  }
  if (wordHit !== -1) return { score: FUZZY_TIER_SCORE.word, tier: "word", positions: range(wordHit, trimmed.length) };
  if (plainHit !== -1) return { score: FUZZY_TIER_SCORE.substring, tier: "substring", positions: range(plainHit, trimmed.length) };

  // A typo before a scattered subsequence: "sesion" is one edit away from the
  // word "session", which explains the hit better than the same letters
  // spread across the text.
  const typo = typoMatch(lowerTerm, lowerText);
  if (typo) return typo;
  return subsequenceMatch(lowerTerm, lowerText, text);
}

/**
 * Every term against one text, one result each. Null when a term is nowhere
 * in it: a query of several words needs all of them.
 */
export function fuzzyMatchTerms(terms: readonly string[], text: string): FuzzyMatch[] | null {
  const matches: FuzzyMatch[] = [];
  for (const term of terms) {
    const match = fuzzyMatchTerm(term, text);
    if (!match) return null;
    matches.push(match);
  }
  return matches;
}

/**
 * A whole query against one text. The tier is the worst of the terms' tiers
 * (a query is only as good as its weakest word), and the score is the sum.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  const matches = fuzzyMatchTerms(terms, text);
  if (!matches) return null;
  let score = 0;
  let tier: FuzzyTier = "exact";
  const positions = new Set<number>();
  for (const match of matches) {
    score += match.score;
    if (fuzzyTierRank(match.tier) > fuzzyTierRank(tier)) tier = match.tier;
    for (const position of match.positions) positions.add(position);
  }
  return { score, tier, positions: [...positions].sort((a, b) => a - b) };
}
