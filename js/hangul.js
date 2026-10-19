// 한글 → 로마자(국어의 로마자 표기법, 주요 소리 규칙). 앱(Hangul.cs)과 같은 규칙. 예: 율리봉 → Yullibong, 독립문 → Dongnimmun.
const INIT = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const VOWEL = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const FINAL = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
const LIAISON = ['', 'g', 'kk', 'ks', 'n', 'nj', 'n', 'd', 'r', 'lg', 'lm', 'lb', 'ls', 'lt', 'lp', 'r', 'm', 'b', 'ps', 's', 'ss', 'ng', 'j', 'ch', 'k', 't', 'p', ''];
const I_N = 2, I_R = 5, I_M = 6, I_NG = 11, I_H = 18;
const isSyl = c => c >= '가' && c <= '힣';
const isDigit = c => c >= '0' && c <= '9';
export const hasHangul = s => !!s && [...s].some(isSyl);

export function romanize(s) {
  if (!hasHangul(s)) return s;
  let out = '', wordStart = true, pending = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!isSyl(c)) { if (isDigit(c) && i > 0 && isSyl(s[i - 1])) out += ' '; out += c; wordStart = true; continue; }
    if (i > 0 && isDigit(s[i - 1])) { out += '-'; wordStart = false; }
    const code = c.charCodeAt(0) - 0xac00, ini = Math.floor(code / 588), vow = Math.floor((code % 588) / 28), fin = code % 28;
    let syl = (pending ?? INIT[ini]) + VOWEL[vow]; pending = null;
    let tail = FINAL[fin];
    if (fin && i + 1 < s.length && isSyl(s[i + 1])) {
      const nIni = Math.floor((s.charCodeAt(i + 1) - 0xac00) / 588), cls = FINAL[fin];
      if (nIni === I_NG) { tail = ''; pending = LIAISON[fin]; if (fin === 21) { tail = 'ng'; pending = ''; } }
      else if (nIni === I_R && (cls === 'l' || cls === 'n')) { tail = 'l'; pending = 'l'; }
      else if (nIni === I_R && (cls === 'm' || cls === 'ng')) pending = 'n';
      else if (nIni === I_R && cls === 'k') { tail = 'ng'; pending = 'n'; }
      else if (nIni === I_R && cls === 'p') { tail = 'm'; pending = 'n'; }
      else if (nIni === I_N || nIni === I_M) {
        if (cls === 'k') tail = 'ng'; else if (cls === 'p') tail = 'm'; else if (cls === 't') tail = 'n'; else if (cls === 'l' && nIni === I_N) pending = 'l';
      } else if (nIni === I_H && fin === 27) tail = '';
    }
    syl += tail;
    if (wordStart && syl) syl = syl[0].toUpperCase() + syl.slice(1);
    out += syl; wordStart = false;
  }
  return out;
}
