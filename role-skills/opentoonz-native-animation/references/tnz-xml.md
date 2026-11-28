# .tnz XML 구조와 좌표 계산 (OpenToonz 1.8.0)

아래 내용은 OpenToonz 1.8.0이 실제로 저장한 장면과 v1.8.0 소스에서 확인한 것입니다. 다른 버전에서는 저장한 장면을 먼저 열어 구조를 대조합니다.

## 최상위와 출력

- 루트는 `<tnz framecount="N">`이고 `<generator>`에 `OpenToonz 1.8`이 들어 있습니다. 프레임 수를 바꾸면 `framecount`도 고칩니다.
- `properties/outputs/output` 아래의 `fps`, `range`(0부터: `0 N-1`), `path`(`"+outputs/name.png"`), `bpp`(`32`)를 고칩니다.
- 배경색은 `properties/bgColor`에 `R G B A`(0–255) 문자열로 씁니다.
- 카메라는 `.//camera`의 `cameraSize`(인치, `폭/카메라DPI 높이비율`)와 `cameraRes`(`폭 높이` 픽셀)입니다. 예: 640×360 출력에 카메라 DPI 72이면 `cameraSize`의 폭은 `640/72`입니다.

## level

- `levelSet/levels/level`의 텍스트가 level 이름이고, `path`는 프로젝트 기준 경로 `"+drawings/<폴더>/<name>..png"`입니다.
- `info`의 `dpix`·`dpiy`를 직접 씁니다. `dpiType="image"`가 있으면 그 속성만 지웁니다. PNG pHYs의 DPI는 정수로 양자화되어(예: 49.5 → 49.5046) 크기가 어긋나므로 믿지 않습니다.
- 새 level을 추가할 때는 `levelSet/folder[@name='Cast']/levels`에도 같은 id로 등록합니다.
- 새 그림 폴더(`drawings/<폴더>/`)에는 다음 `scenes.xml`을 둡니다.

```xml
<parentProject type="projectFolder">
"../.."
</parentProject>
```

## 노출표(cell)

- `xsheet/columns/column/cells/cell`의 형식은 `시작행 개수 <level id="L"/>그림번호 step`입니다. 그림 번호는 `0001`처럼 네 자리입니다.

```xml
<cell>
12 3 <level id="2"/>0005 0
</cell>
```

- column을 복제해 추가할 때는 `fx/Toonz_columnFx`의 id를 새로 주고, `xsheet/fxnodes/terminal`에 같은 id의 `fxnode`를 추가해야 렌더에 나옵니다.

## pegbar 키 채널

- column의 위치·배율은 `xsheet/pegbars/pegbar[@id='ColN']`의 `x`, `y`, `sc`(전체 배율, 1=100%), `sx`, `sy` 채널입니다. 실제 축 배율은 `sc*sx`, `sc*sy`입니다. 카메라는 `Camera1`의 같은 채널과 `z`를 씁니다.
- 채널 형식(선형 키 `L`만 확인함):

```xml
<x>
  <default>6.2916666666666670</default>
  <keyframes>
    <L>
0 6.2916666666666670
</L>
    <L><prev>5.1</prev>
12 5.1
</L>
  </keyframes>
</x>
```

- 첫 키는 `L`의 텍스트에 `프레임 값`을 씁니다. 다음 키부터는 `<prev>`에 이 키 값을 넣고, 그 tail에 `프레임 값`을 씁니다. 소스상 `prev`는 이전 키의 값이 아니라 현재 키로 들어오는 값입니다. 실제로 저장된 장면에서 값이 바뀌는 구간의 키를 열어 형식을 한 번 대조합니다.
- 키 프레임 번호는 0부터 셉니다. 출력 F1이 키 0입니다.
- 비선형 보간(S/E/Ep)의 속도 핸들 필드는 GUI 저장 견본과 대조하기 전에는 쓰지 않습니다. 감속·가속은 프레임마다 L 키를 찍어 표현합니다.

## 좌표 계산

- 카메라 DPI는 `cameraRes 폭 / cameraSize 폭`입니다. 예: 1080×1920 출력의 `cameraSize`가 `15 26.6667`이면 카메라 DPI는 72입니다.
- pegbar `x`·`y`는 카메라 DPI 기준 인치 단위이며, 카메라 중심을 원점으로 y가 위쪽으로 커집니다. 픽셀 이동량은 `Δpx / 카메라DPI`로 바꿉니다.
- level은 그림 중심에 놓입니다. 그림 안의 기준점(발 위치 등)을 화면 목표 좌표에 맞추는 오프셋은 그림 크기·level DPI·전체 배율에 따라 달라집니다. 일반식을 믿지 말고, 키 0 하나로 시험 렌더한 뒤 출력에서 기준점의 실제 픽셀 위치를 측정해 상수를 정합니다.
- 정한 값은 GUI의 변환 표시(mm)와 tcomposer 출력으로 대조하고, 측정한 위치와 남은 오차를 증거에 기록합니다.

## FX (GUI 저장 견본이 필요함)

v1.8.0 소스에서 확인한 이름이며, 장면 안의 외피 구조는 검증하지 않았습니다.

- Linear Gradient 현행판: `STD_iwa_LinearGradientFx`, `startPoint`·`endPoint`(x/y), `startColor`·`endColor`(RGBA 태그 `red`·`green`·`blue`·`matte`, 0–1). 구판 `STD_linearGradientFx`(`period`·`color1`·`color2`)와 섞어 쓰지 않습니다.
- Matte In: `inFx`, 포트 `Source`·`Matte`. 원본과 마스크가 terminal에 따로 연결되면 중복 출력됩니다.
- Cross Dissolve: `STD_inoCrossDissolveFx`, 포트 `Fore`·`Back`, `opacity` 0–1(0=Back, 1=Fore).
