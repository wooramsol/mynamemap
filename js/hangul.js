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

// 음절 안에서 자모 자리 나누기 (100×100 상자)
export function syllableBoxes(s) {
  if (s.single) return [[s.single, [5, 5, 90, 90]]];
  const v = s.jung, jong = s.jong;
  const out = [];
  const put = (j, box) => {
    const parts = basic(j);
    if (parts.length === 1) return out.push([j, box]);
    const [x, y, w, h] = box;
    parts.forEach((p, i) => out.push([p, [x + i * w / parts.length, y, w / parts.length, h]])); // 쌍자음·겹받침은 나란히
  };
  if (VERTICAL_VOWELS.has(v)) {
    const H = jong ? 60 : 100;
    put(s.cho, [0, 0, 56, H]); put(v, [56, 0, 44, H]);
  } else if (HORIZONTAL_VOWELS.has(v)) {
    if (jong) { put(s.cho, [15, 0, 70, 38]); put(v, [0, 38, 100, 26]); }
    else { put(s.cho, [10, 0, 80, 55]); put(v, [0, 55, 100, 45]); }
  } else { // ㅘ ㅝ ㅢ 같은 섞인 모음
    const H = jong ? 72 : 100;
    const [h, vv] = basic(v);
    put(s.cho, [0, 0, 60, H * .5]); put(h, [0, H * .5, 66, H * .5]); put(vv, [66, 0, 34, H]);
  }
  if (jong) put(jong, [10, 64, 80, 36]);
  return out;
}
