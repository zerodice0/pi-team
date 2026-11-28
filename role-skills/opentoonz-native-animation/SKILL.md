---
name: opentoonz-native-animation
description: OpenToonz 1.8로 2D 애니메이션 장면(.tnz)을 코드로 작성하고 실제 앱에서 저장·재열기한 뒤 tcomposer로 렌더해 영상으로 만들 때 사용합니다. ToonzScript 골격 저장과 Python XML 편집, level·노출표·카메라·pegbar 키, 자기 GUI 창 조작과 캡처, 렌더 프레임·보호 구간 픽셀 검증, ffmpeg 인코딩까지 다룹니다. 캐릭터 원화 제작이나 다른 렌더러 합성에는 사용하지 않습니다.
---

# OpenToonz 네이티브 애니메이션 제작

「OpenToonz로 만들었다」는 말은 실제 OpenToonz가 장면을 저장하고, 다시 열고, tcomposer가 프레임을 렌더했다는 뜻입니다. 다른 도구로 완성한 영상에 OpenToonz 이름만 붙이거나, 실행 확인 없이 `.tnz`를 손으로만 쓴 것은 완료가 아닙니다. ffmpeg는 tcomposer가 렌더한 PNG를 인코딩하고 증거를 추출하는 데만 씁니다.

## 시작하기 전에

1. **실행기를 찾습니다.** 시스템 패키지가 아니라 사용자 전용 설치일 수 있습니다. 이 호스트(winmini)의 실행기는 `~/.local/opt/opentoonz-1.8.0/bin/opentoonz-local`이며, 첫 인자로 `tcomposer`·`tconverter`를 받습니다. 실행기가 설정하는 라이브러리·Qt 플러그인 경로를 우회해 `root/usr/bin`의 실행 파일을 직접 부르지 않습니다.
2. **공용 HOME을 확인합니다.** 이 실행기는 `HOME`을 설치본의 `home/`으로 고정하고 `TOONZROOT` 등을 그 아래로 지정합니다. 그래서 같은 설치본의 GUI·tcomposer를 다른 세션과 동시에 돌리면 설정과 캐시가 섞입니다. 시작 전에 `pgrep -a -x 'opentoonz|tcomposer'`가 비어 있는지 보고, 있으면 멈추고 조율합니다.
3. **표시 환경을 읽습니다.** 에이전트 패널에는 `DISPLAY`가 비어 있을 수 있습니다. 매 실행 직전에 `systemctl --user show-environment`에서 `DISPLAY`, `XAUTHORITY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`를 가져오고 `QT_QPA_PLATFORM=xcb`로 띄웁니다. `XAUTHORITY` 경로는 로그인마다 바뀌므로 기록된 값을 재사용하지 않습니다. 값을 추측하거나 Xvfb를 새로 설치하지 않습니다.
4. **도구를 확인합니다.** 창 조작에 `xdotool`, 창 캡처에 ImageMagick `import`, 인코딩에 `ffmpeg`·`ffprobe`, 픽셀 검사에 Pillow·numpy가 있는 Python이 필요합니다. PATH의 `python3`가 Pillow 없는 인터프리터로 잡힐 수 있으니 실제 인터프리터를 확인합니다.
5. 작업 파일·렌더·캡처·로그는 작업 저장소 경로에 둡니다. `/tmp`에 두지 않으며, GUI의 `TMPDIR`도 작업 경로 아래로 지정합니다.

## 제작 순서

### 1. 입력과 노출표를 고정합니다

- 사용할 그림의 출처·크기·알파·SHA-256을 manifest에 기록합니다. level 폴더에는 원본을 바꾸지 않은 사본을 둡니다.
- 출력 해상도·fps·전체 프레임 수와 프레임별 셀(노출표)을 CSV나 JSON으로 먼저 정합니다. 카메라·전체 이동 키도 프레임 단위 값으로 정해 둡니다.
- 셀 크기가 다른 level(예: 176px와 256px)을 같은 크기로 늘려 붙이지 않습니다. level마다 DPI를 따로 지정해 물리 크기를 맞춥니다.

### 2. ToonzScript로 장면 골격을 저장합니다

- 장면 XML을 처음부터 추측해 쓰지 않습니다. 공식 ToonzScript `Scene`·`loadLevel`·`setCell`·`save`로 골격 `.tnz`를 실제 앱이 저장하게 합니다.
- 스크립트는 파일로 만들고 GUI의 File → Script → Open Script Console에서 `run(경로변수 + 'author.toonzscript')`로 실행합니다. 긴 명령을 콘솔에 직접 입력하면 구문 오류가 납니다.
- level은 `name..png`(점 두 개)로 불러오고, 그림 파일은 `name.0001.png`처럼 번호를 붙입니다. 번호 없는 PNG의 프레임 ID `-`는 `setCell`이 거부합니다.
- `setCell(row, column, level, frameNumber)`의 row는 0부터 셉니다. 출력 F1은 row 0입니다.

### 3. 저장된 XML을 Python으로 고칩니다

- ToonzScript가 다루지 못하는 카메라 크기·출력 설정·level DPI·pegbar 키·새 column은 저장된 `.tnz`를 `xml.etree.ElementTree`로 읽어 고칩니다. 고치기 전에 `generator`가 기대한 버전인지, 프레임 수와 pegbar center가 예상대로인지 assert합니다.
- XML 구조와 좌표 계산은 `references/tnz-xml.md`를 읽습니다.
- 원본 골격 장면은 남기고 새 이름으로 저장합니다. 수정 회차마다 장면·렌더·증거를 새 이름이나 `revision-N/` 폴더에 두어 이전 결과를 덮어쓰지 않습니다.
- **FX는 GUI 저장 견본이 있을 때만 씁니다.** Linear Gradient·Matte In·Cross Dissolve·opacity 같은 FX의 XML 외피(column·terminal·port 연결)는 추측하기 쉽고 틀리기도 쉽습니다. GUI로 해당 FX를 연결해 저장한 작은 견본 장면을 먼저 확보합니다. 견본이 없으면 투명도 변화는 RGB를 그대로 두고 알파만 바꾼 RGBA 파생 level을 프레임별로 만들어 노출합니다.

### 4. 실제 GUI에서 저장하고 다시 엽니다

- 자기가 띄운 GUI 프로세스의 창만 다룹니다. `xdotool search --onlyvisible --pid <자기 PID>`로 창 ID를 찾고, `import -window <창 ID>`로 그 창만 캡처합니다. 전체 화면이나 다른 사람의 창을 캡처하지 않습니다.
- 다른 프로젝트 폴더의 장면을 열면 「OpenToonz 1.8 - Question」 대화상자가 프로젝트 전환을 묻습니다. 이 창도 자기 PID로 찾아 캡처한 뒤 응답합니다.
- 저장은 Ctrl+S(장면만 저장)를 씁니다. Save All은 level 파일까지 다시 써서 원본 그림을 바꿀 수 있으므로 쓰지 않습니다.
- 정상 종료 뒤 별도 실행으로 같은 장면을 다시 열어 level 연결이 깨지지 않았는지 캡처합니다. 캡처의 프레임 번호가 의도한 값인지 직접 확인합니다. frame 필드 클릭·입력으로 seek하는 좌표는 창 배치에 따라 달라지므로 캡처로 결과를 확인합니다.
- GUI 뷰어의 Fit to Window(Alt+9) 화면은 level 전체 범위를 보여 주므로 출력 프레이밍의 근거가 아닙니다. 프레이밍은 tcomposer 출력으로 판단합니다.
- 종료는 자기 창에 Ctrl+Q를 보내고, 응답이 없으면 자기 PID에만 SIGTERM → SIGKILL을 보냅니다. `pkill opentoonz`처럼 이름으로 일괄 종료하지 않습니다. 종료 방법·종료 코드·잔여 프로세스를 기록합니다.

### 5. tcomposer로 렌더하고 검사합니다

```sh
opentoonz-local tcomposer <scene.tnz> -o <out-dir>/<name>.png -range 1 <N> -nthreads 1
```

- 출력은 `<name>.0001.png`부터 번호가 붙습니다. 기대한 파일 목록과 정확히 같은지, 모든 프레임의 크기·모드·알파 범위가 맞는지 확인합니다.
- 이전 회차에서 채택한 구간이 있으면 새 렌더의 그 구간을 이전 렌더와 RGBA 전체 픽셀로 비교해 차이가 0인지 확인합니다. 바꾸려던 구간만 달라졌는지도 기록합니다.
- 렌더는 무거운 작업입니다. 다른 세션의 렌더·빌드와 겹치지 않게 하고 `-nthreads 1`로 돌립니다.

### 6. ffmpeg로 인코딩하고 확인합니다

```sh
ffmpeg -hide_banner -y -framerate <fps> -start_number 1 -i <out-dir>/<name>.%04d.png \
  -frames:v <N> -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart <name>.mp4
ffprobe -v error -count_frames -show_streams -show_format -of json <name>.mp4
ffmpeg -hide_banner -v error -xerror -i <name>.mp4 -f null -
```

- ffprobe로 해상도·`r_frame_rate`·`nb_read_frames`·길이·코덱·pix_fmt를 확인하고, 전체 decode가 종료 코드 0인지 봅니다.
- 전환 구간은 전 프레임 스트립과 정상 속도 클립을 따로 뽑아 확인합니다.

### 7. 증거를 남깁니다

- 실행기 경로·버전·작업 디렉터리·환경 변수·정확한 명령·종료 코드, 장면과 입력의 SHA-256, 프레임별 해시, 보호 구간 비교 결과, GUI 저장·재열기 캡처, 영상의 ffprobe 결과를 JSON으로 남깁니다.
- 다시 렌더할 수 있는 명령을 README에 적습니다.
- 렌더 성공(기술 검증)과 시각 수용(사람이나 리뷰어의 판정)을 따로 기록합니다. 도구가 exit 0으로 끝났다는 사실을 품질 PASS로 보고하지 않습니다.

## 하지 않을 것

- 다른 렌더러나 합성 도구로 결과를 만들고 OpenToonz 결과라고 하지 않습니다. tcomposer가 안 되면 대체하지 말고 막힌 원인을 보고합니다.
- 실행기를 우회하거나, 공용 설치본을 다른 세션과 동시에 쓰거나, 남의 OpenToonz 프로세스를 종료하지 않습니다.
- GUI로 저장해 본 적 없는 FX·보간 형식(S/E/Ep 속도 핸들 등)을 이미 지원한다고 가정하지 않습니다.
