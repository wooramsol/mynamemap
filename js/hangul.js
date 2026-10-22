// 한글 음절 → 자모 분해
export const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
export const JUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
export const JONG = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];

// 길에서 찾기 어려운 겹자모는 기본 자모 여러 개로 나눠서 찾는다
export const SPLIT = {
  'ㄲ':['ㄱ','ㄱ'],'ㄸ':['ㄷ','ㄷ'],'ㅃ':['ㅂ','ㅂ'],'ㅆ':['ㅅ','ㅅ'],'ㅉ':['ㅈ','ㅈ'],
  'ㄳ':['ㄱ','ㅅ'],'ㄵ':['ㄴ','ㅈ'],'ㄶ':['ㄴ','ㅎ'],'ㄺ':['ㄹ','ㄱ'],'ㄻ':['ㄹ','ㅁ'],
  'ㄼ':['ㄹ','ㅂ'],'ㄽ':['ㄹ','ㅅ'],'ㄾ':['ㄹ','ㅌ'],'ㄿ':['ㄹ','ㅍ'],'ㅀ':['ㄹ','ㅎ'],'ㅄ':['ㅂ','ㅅ'],
  'ㅘ':['ㅗ','ㅏ'],'ㅙ':['ㅗ','ㅐ'],'ㅚ':['ㅗ','ㅣ'],'ㅝ':['ㅜ','ㅓ'],'ㅞ':['ㅜ','ㅔ'],'ㅟ':['ㅜ','ㅣ'],
  'ㅢ':['ㅡ','ㅣ'],'ㅒ':['ㅑ','ㅣ'],'ㅖ':['ㅕ','ㅣ'],'ㅔ':['ㅓ','ㅣ'],
};

export const VERTICAL_VOWELS = new Set(['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅣ']);
export const HORIZONTAL_VOWELS = new Set(['ㅗ','ㅛ','ㅜ','ㅠ','ㅡ']);

export function basic(j) { return SPLIT[j] || [j]; }

/** "정우람솔" → [{char:'정', cho:'ㅈ', jung:'ㅓ', jong:'ㅇ'}, ...] */
export function decompose(text) {
  const out = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c >= 0xAC00 && c <= 0xD7A3) {
      const i = c - 0xAC00;
      out.push({ char: ch, cho: CHO[Math.floor(i / 588)], jung: JUNG[Math.floor((i % 588) / 28)], jong: JONG[i % 28] });
    } else if (c >= 0x3131 && c <= 0x3163) {
      out.push({ char: ch, single: ch });
    }
  }
  return out;
}

/** 이름에 필요한 기본 자모 목록 (중복 제거, 순서 유지) */
export function neededJamo(syllables) {
  const set = [];
  const add = j => { if (!j) return; for (const b of basic(j)) if (!set.includes(b)) set.push(b); };
  for (const s of syllables) { add(s.single); add(s.cho); add(s.jung); add(s.jong); }
  return set;
}
