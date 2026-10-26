# mynamemap

이름을 입력하면 지도 속 **길 모양**에서 한글 자모를 찾아, 길로 쓴 내 이름을 만들어 주는 웹사이트입니다.

## 두 가지 모드

- **전국**: 전국 길·건물·철도·개천을 미리 분석하고, 후보를 **사람 눈으로 하나씩 검토해 바로 읽히는 것만** 남긴 결과(`data/`)에서 찾습니다. 자주 쓰는 2,350자(KS X 1001) 중 631자.
- **지금 보는 지역**: 지도 범위의 도로를 실시간으로 불러와 찾습니다.

두 모드 모두 **길 묶음이 실제로 한 글자로 읽히는 곳만** 결과로 보여줍니다. 찾는 방법은 두 가지입니다.

1. **자모 조합** (`js/syllable.js`, `scripts/compose.mjs`): 자모 후보들이 음절 배치대로 붙어 있는 곳
2. **음절 모양 비교** (`js/glyph.js`, `scripts/glyph.mjs`): 자모 하나를 기준으로 음절 틀을 잡고,
   틀 안의 길 전체를 음절 글꼴 뼈대와 30×30 격자에서 겹쳐 봄. 자모마다 획 위에 길이 있어야 하고,
   글자 밖 길이나 획 옆에 겹겹이 있는 길이 많으면 감점. 자모가 깔끔하게 따로 잡히지 않아도 전체가 그 글자로 읽히면 찾음
   - 획(선분) 하나하나에 길이 있어야 함 (가로줄 셋 '≡'을 '드'로 읽지 않도록)
   - 글씨체 변형: ㅈ·ㅊ(가로획+ㅅ / 손글씨형), ㅎ(꼭지 있음/없음)
   - 전국 데이터는 **길 + 건물**을 함께 씀: 길쭉한 아파트 동은 가운데 선(ㅡ·ㅣ 획), ㄱ·ㄷ자 건물은 뼈대, 둥근 건물은 ㅇ

자모를 여기저기서 따로 찾아 이어 붙이지 않으며, 못 찾은 글자는 회색으로 표시합니다. 카드에는 길의 실제 배치를 그대로 그립니다.

## 작동 방식 (지역 모드)

1. 지금 보고 있는 지도 범위의 도로 데이터를 OpenStreetMap(Overpass API)에서 불러옵니다.
2. 도로를 교차로·꺾이는 점(노드)과 거의 직선인 도로 조각(엣지)으로 된 그래프로 바꿉니다. (`js/graph.js`)
3. 자모 후보를 찾은 뒤 위의 두 방법(`js/syllable.js`, `js/glyph.js`)으로 한 글자로 읽히는 곳만 고릅니다.
   자모 찾기: 이름을 자모로 분해하고(`js/hangul.js`), 자모마다 획 구조 템플릿(`js/templates.js`)과 같은 연결 구조·방향·비율을 가진 길을 찾습니다. (`js/matcher.js`)
   - ㅇ(ㅎ)은 둥글게 닫힌 길을 원형도로 찾습니다.
   - 획 끝이 막다른 길이고, 글자 밖으로 뻗은 길이 적을수록 점수가 높습니다.
4. 가장 잘 맞는 후보로 이름 카드를 그리고, 지도에 위치를 표시합니다.

서버 없이 브라우저에서 모두 동작하므로 GitHub Pages에 그대로 올릴 수 있습니다.

## 로컬 실행

```bash
python3 -m http.server 8000
# http://localhost:8000
```

엔진 테스트: `node test/synthetic.mjs`

## 전국 데이터 다시 만들기

```bash
pip install osmium
# https://download.geofabrik.de/asia/south-korea.html 에서 south-korea-latest.osm.pbf 받기
python3 scripts/extract.py south-korea-latest.osm.pbf work/ways.bin              # 차도만 (약 1분)
python3 scripts/extract.py south-korea-latest.osm.pbf work/ways_foot.bin --foot  # 보행로·산책로·단지 길 포함
node scripts/scan.mjs work/ways.bin work/cands.jsonl                # 4km 격자 5,900여 칸 자모 후보 (2코어 약 40분)
node scripts/scan.mjs work/ways_foot.bin work/cands_foot.jsonl      # (약 45분)
cat work/cands.jsonl work/cands_foot.jsonl > work/cands_all.jsonl
node --max-old-space-size=6000 scripts/compose.mjs work/cands_all.jsonl work/compose   # 자모 조합 (약 25분)
python3 scripts/extract_buildings.py south-korea-latest.osm.pbf work/ways_bld.bin  # 건물 → 획 (약 5분, shapely·scikit-image 필요)
node scripts/scan.mjs work/ways_bld.bin work/cands_bld.jsonl                          # 건물 획의 자모 후보 (약 1분)
# 길+건물 합치기: ways_foot.bin과 ways_bld.bin의 길 수를 더해 헤더로 쓰고 본문을 이어 붙임 → work/ways_combo.bin
cat work/cands_all.jsonl work/cands_bld.jsonl > work/cands_combo.jsonl
node scripts/glyph.mjs work/ways_combo.bin work/cands_combo.jsonl work/glyph.jsonl       # 음절 모양 비교, KS X 1001 2,350자 (2코어 약 2시간)
python3 scripts/extract_extra.py south-korea-latest.osm.pbf work/ways_extra.bin    # 철도·개천·운동장 트랙
# (ways_extra.bin 도 scan 해서 후보에 더하고, 길+건물+기타를 합친 파일로 glyph.mjs 실행)
TOP_SYL=8 node --max-old-space-size=6000 scripts/compose.mjs work/cands_all.jsonl work/compose8
# 검토: 후보 모으기 → 모음 그림 → 눈으로 보고 통과 번호 적기 → data/
python3 scripts/review/pool.py work/pool.jsonl work/glyph.jsonl:36 work/compose8:28
node scripts/review/sheet.mjs work/pool.jsonl work/sheets           # 48칸씩 그림 (번호·글자 표시)
python3 scripts/review/build.py data work/pool.jsonl:work/approved.txt
```

- `scan.mjs`: 칸마다 모든 자모 템플릿을 돌려 후보(점수·방향·크기·모양)를 저장
- `compose.mjs`: 첫 자모(초성)를 기준으로 나머지 자모가 음절 배치(`syllableBoxes`)대로 놓여 있는지 확인해 11,172개 음절 각각의 상위 3곳을 고름. ㅈ(=ㅡ+ㅅ), ㅎ(=ㅡ+ㅇ)은 두 후보를 위아래로 붙여 만들기도 함

## 다음 단계

- 장소 이름(동네 이름) 표시
- ㅎ 전용 템플릿, 결과 공유 링크 이미지

도로 데이터 © OpenStreetMap contributors (ODbL)
