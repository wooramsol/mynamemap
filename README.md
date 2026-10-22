# mynamemap

이름을 입력하면 지도 속 **길 모양**에서 한글 자모를 찾아, 길로 쓴 내 이름을 만들어 주는 웹사이트입니다.

## 두 가지 모드

- **전국**: 전국 도로를 미리 분석해 둔 결과(`data/`)에서 음절을 찾습니다.
- **지금 보는 지역**: 지도 범위의 도로를 실시간으로 불러와 찾습니다.

두 모드 모두 **자모가 실제로 한 글자 배치로 붙어 있는 곳만** 결과로 보여줍니다
(예: ㄹ·ㅏ·ㅁ이 '람' 모양으로 한 곳에 모여 있는 길). 자모를 여기저기서 따로 찾아
이어 붙이지 않으며, 못 찾은 글자는 회색으로 표시합니다. 카드에는 길의 실제 배치를 그대로 그립니다.

## 작동 방식 (지역 모드)

1. 지금 보고 있는 지도 범위의 도로 데이터를 OpenStreetMap(Overpass API)에서 불러옵니다.
2. 도로를 교차로·꺾이는 점(노드)과 거의 직선인 도로 조각(엣지)으로 된 그래프로 바꿉니다. (`js/graph.js`)
3. 이름을 자모로 분해하고, 자모 후보를 찾은 뒤 `js/syllable.js`로 한 음절 배치로 붙어 있는 조합만 고릅니다.
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
python3 scripts/extract.py south-korea-latest.osm.pbf work/ways.bin      # 도로만 추출 (약 1분)
node scripts/scan.mjs work/ways.bin work/cands.jsonl                       # 4km 격자 5,900여 칸 자모 후보 (2코어 약 40분)
node --max-old-space-size=5000 scripts/compose.mjs work/cands.jsonl data   # 음절 조합 → data/ (약 7분)
```

- `scan.mjs`: 칸마다 모든 자모 템플릿을 돌려 후보(점수·방향·크기·모양)를 저장
- `compose.mjs`: 첫 자모(초성)를 기준으로 나머지 자모가 음절 배치(`syllableBoxes`)대로 놓여 있는지 확인해 11,172개 음절 각각의 상위 3곳을 고름. ㅈ(=ㅡ+ㅅ), ㅎ(=ㅡ+ㅇ)은 두 후보를 위아래로 붙여 만들기도 함

## 다음 단계

- 장소 이름(동네 이름) 표시
- 보행로까지 포함한 전국 데이터
- ㅎ 전용 템플릿, 결과 공유 링크 이미지

도로 데이터 © OpenStreetMap contributors (ODbL)
