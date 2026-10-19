// Total orders for every sort in src/gen (design 3.0 rule 3). Numbers are compared with < and >, and every tie
// is broken by an integer id, so V8 and JavaScriptCore give the same order. Quantiles take the element at
// index floor(q * (n - 1)) of such a sort (no interpolation). gen_tests/lint.mjs fails on any `.sort(` in
// src/gen that does not use one of these comparators.

export const cmpNum = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// strings by UTF-16 code units (keys of canonical JSON; equal strings are indistinguishable)
export const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// objects by a numeric key, ties by `id`
export const byNum = (key) => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// objects by `score` descending (best first), ties by `id` ascending
export const byScoreThenId = (a, b) => (a.score > b.score ? -1 : a.score < b.score ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// a sorted copy of a list of numbers (equal numbers are indistinguishable, so no id is needed). A Float64Array's own
// sort is ECMAScript's numeric order (fully specified: -0 before +0, NaN last), the same total order in every engine and
// the same as sorting with cmpNum up to the place of -0 and +0, which compare and print alike; it is several times
// faster than a comparator call per comparison (stage 3c: 45 of the plan's milliseconds). lint.mjs allows this one
// sort without a comparator, here only.
export function sortedNums(list) {
  const a = list instanceof Float64Array ? list.slice() : Float64Array.from(list);
  a.sort();
  return a;
}

// the q-quantile of an already sorted list
export const quantileSorted = (s, q) => s[Math.floor(q * (s.length - 1))];

export function quantile(list, q) {
  return quantileSorted(sortedNums(list), q);
}

// 101 knots (every 1%) of a sorted list, and the rank of a value against them in [0, 1] (linear between
// knots). This is how T and H become the quantile ranks t and h of the biome table (3.3).
export function knots(sorted, n = 100) {
  const k = new Array(n + 1);
  for (let i = 0; i <= n; i++) k[i] = quantileSorted(sorted, i / n);
  return k;
}

export function rankOf(K, v) {
  const n = K.length - 1;
  if (!(v > K[0])) return 0;
  if (!(v < K[n])) return 1;
  let lo = 0, hi = n;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (K[m] <= v) lo = m; else hi = m;
  }
  const span = K[hi] - K[lo];
  return (lo + (span > 0 ? (v - K[lo]) / span : 0)) / n;
}
