# pi-team

`pi-team`은 [pi](https://pi.dev) 1.6+ 확장입니다. 필요할 때만 서브에이전트 **팀**을 띄워 작업을 맡깁니다. 팀마다 다음이 따로 주어집니다.

- git worktree 하나와 branch `pi-team/<team>`
- 사용자가 직접 대화하는 **팀장**(worktree에서 메인 모드처럼 도는 대화형 pi 세션: 실제 orchestrator 모델로 작은 일은 직접 하고 나머지는 팀원에게 맡김)
- 팀장이 [pi-subagents](https://www.npmjs.com/package/pi-subagents)로 위임하는 역할별 팀원(task, scout, reviewer, vision, art-reviewer, image, modeler, animator 등)

메인 pi 세션의 모델과 도구는 `/team main`을 실행하지 않는 한 바뀌지 않습니다. 설계 전문은 [`docs/DESIGN.md`](docs/DESIGN.md)에 있습니다.

## 주요 기능

- **역할 → 모델 preset:** 팀원 역할은 virtual model(`team/<preset>.<role>`)로 등록되며, fallback 체인과 cooldown을 따라 모델을 고릅니다. preset은 상속 구조이므로, 새 모델이 나오면 모델 별칭 한 줄만 바꿉니다. 기본 preset은 `mix`, `advanced`, `claude`, `claude-advanced`, `codex`, `codex-advanced`입니다.
- **메인 모드(`/team main <preset>`):** 메인 세션이 preset의 orchestrator 모델로 실행되고, 역할별 agent(`pi-team.<role>`)에게 바로 위임합니다.
- **서브에이전트 들여다보기:** 팀장 화면 아래의 pi-subagents FleetView에서, 입력창이 비어 있을 때 `↓`나 `←`를 누르면 실행 중인 구성원 목록이 열립니다. `/subagents-fleet`은 구성원의 대화·도구 기록을 실시간으로 보고, `s`로 지시를 보내고, `D`로 멈출 수 있는 inspector입니다. Herdr 안에서는 `H`로 구성원 대시보드를 옆 pane에 엽니다.
- **팀 안 메시징:** 팀원끼리 파일 mailbox로 메시지를 주고받고, `replyTo`로 스레드를 잇습니다. 다른 팀과는 팀장끼리만 주고받습니다.
- **`/team board`:** 모든 팀의 목표, 각 worktree, 구성원별 실제 모델·상태·현재 도구, 메시지와 요약을 보여 주는 overlay입니다. widget도 함께 표시합니다.
- **상태 줄 widget:** 편집창 위의 한 줄에 메인 모드 preset(`team main: mix`)과 이 저장소의 팀 진행 상황(`teams: …`)을 보여 줍니다. 메인 모드가 켜져 있으면 팀이 없어도 보입니다. fullscreen 모드에서는 이 줄을 누르면 팀 패널이 열리고 닫힙니다.
- **팀 패널(`ctrl+shift+t`·`alt+t`):** 대화를 계속하면서 볼 수 있도록 화면 오른쪽에 떠 있는 패널입니다. 팀마다 진행 요약, 목표, 메인이 마지막으로 보낸 위임, 팀장과 팀원이 지금 하는 일과 모델, 마지막 메시지를 보여 줍니다. fullscreen 모드(pi 기본값)에서는 제목 줄을 마우스로 끌어 옮길 수 있고, 옮긴 위치는 기억합니다. 패널과 상태 줄 widget은 지금 세션의 저장소에 속한 팀만 보여 줍니다. 메인 checkout, 그 하위 폴더, 팀 worktree를 포함한 그 저장소의 모든 worktree는 Git의 공통 디렉터리로 같은 저장소로 판단합니다. 다른 저장소의 팀은 아래 테두리에 「+N in other repos」로 개수만 보여 줍니다. Git 저장소 밖에서는 모든 팀을 보여 줍니다. 팀 아래에는 이 세션의 백그라운드 subagent(`⋮ subagents`)를 실행마다 두 줄(하는 일과 모델, label·턴 수·경과 시간)로 보여 줍니다. 팀장 세션에서는 자기 팀 구성원을 빼고 보여 줍니다. 패널이 화면에 떠 있는 동안에는 화면 아래 pi-subagents의 async widget을 숨기고, 패널을 끄면 다시 보여 줍니다. 설정은 필요 없습니다.
- **Herdr 연동:** [Herdr](https://herdr.dev) 안에서 실행하면 팀마다 `herdr worktree create`로 workspace를 만들고 팀장을 실행합니다. Herdr 밖에서는 worktree만 만들고 팀장 실행 명령을 안내합니다.
- **팀 별칭:** 「그래픽 팀에게 위임해 줘」처럼 자연어로 팀을 지정해 위임할 수 있습니다.
- **팀 제목:** 패널, board, widget, Herdr는 팀 ID 대신 「🐙 폴더블 시뮬레이터 동작 검증」처럼 아이콘과 제목으로 팀을 보여 줍니다. 메인 모델은 팀을 만들 때 제목(`title`)과 영어 ID(`name`)를 함께 정하고, 제목이 없으면 목표의 첫 문장을 씁니다. `/team title`로 언제든 바꿀 수 있습니다.
- **팀 아이콘과 Herdr 표시:** 팀마다 아이콘(별칭의 `icon`, `--icon`, 또는 기본 동물 이모지)과 설명이 붙습니다. Herdr 안의 팀장은 사이드바용 토큰 `$team`(무슨 팀인지)과 `$team_now`(지금 하는 일)를 보고합니다.

## 설치

```sh
pi install npm:pi-subagents
git clone https://github.com/zerodice0/pi-team
pi install ./pi-team
# 선택: image 역할(Codex OAuth)
npm i --prefix ~/.pi/agent/teams/vendor pi-codex-image-gen@0.3.2
```

선택: 팀장과 구성원은 pi-team이 캐시 보존을 정하지만, 메인 세션은 셸의 `PI_CACHE_RETENTION`을 따릅니다(pi에는 이 값을 정하는 설정 키가 없습니다). 메인 세션도 5분 넘게 쉬는 일이 잦다면 셸에 지정하거나 `~/.pi/agent/teams/main.json`에 `"cacheRetention": "long"`을 넣습니다. 메인 세션은 pi의 유휴 캐시 데우기가 동작하므로 필수는 아닙니다. 셸에 두 값(`PI_CACHE_RETENTION`, `PI_SUBAGENT_CACHE_RETENTION`)이 모두 없으면, 그 호스트에서 처음 메인 세션을 시작할 때 한 번 안내합니다(기록: `~/.pi/agent/teams/notices.json`). `/team cache`는 지금 세션의 값과 출처, `main.json` 값, 새 팀장과 구성원이 받을 값, 그리고 이 세션·현재 저장소 팀장·최근 구성원 3명의 최근 캐시 쓰기 20회 가운데 1시간 캐시(`cacheWrite1h`)를 쓴 비율을 보여 줍니다. 적용 여부는 세션 기록의 이 값으로 판단합니다(macOS의 `ps eww`는 다른 프로세스의 환경을 보여 주지 않습니다).

우선순위는 다음과 같습니다.
- 메인 세션: 셸 환경 변수 → `main.json`의 `cacheRetention`·`subagentCacheRetention` → pi 기본값(5분). `main.json`에 `cacheRetention`만 있으면 메인 세션의 서브에이전트는 `short`가 됩니다. `main.json`은 메인 모드를 켰는지와 관계없이 그 호스트의 모든 메인 세션에 적용됩니다.
- 팀장과 구성원: 셸 환경 변수 → pi-team 기본값(팀장 `long`, 구성원 `short`). `main.json` 값은 팀장과 구성원에게 넘어가지 않습니다.

```sh
# fish
set -Ux PI_CACHE_RETENTION long
# bash, zsh
export PI_CACHE_RETENTION=long
```

## 사용법

| 명령 | 설명 |
|---|---|
| `/team start [preset or alias] [--title 제목] [--name X] [--base REF] [--icon 🎨] -- <목표>` | 팀을 만들고 팀장을 띄웁니다. preset을 생략하면 이 호스트의 기본 preset(`/team main <preset> --default`로 정한 값)을 쓰고, 기본값이 없으면 preset을 적으라고 안내합니다. 메인 모델의 `team_start`도 사용자가 preset을 말하지 않으면 생략합니다. `--title`은 다음 옵션 전까지의 단어를 모두 제목으로 씁니다. `--name`은 팀 ID(영어 한 단어, 소문자·하이픈으로 정리)입니다. |
| `/team title <team> <제목>` | 팀 제목을 바꿉니다. 팀장 세션에서는 `/team title <제목>`입니다. ID, branch, 주소는 그대로이고 Herdr workspace 이름(터미널 창 제목)도 함께 바뀝니다. 팀장은 시작할 때마다 workspace 이름을 제목에 맞춥니다. |
| `/team delegate <alias> -- <작업>` | 별칭에 해당하는 기존 팀에 작업을 보내고, 팀이 없으면 새로 만듭니다. |
| `/team stats [role]` · `/team stats import` · `/team stats retro <team>` | 역할별 실행 기록(턴 수, 최대 문맥, 캐시 읽기, 비용)과 스킬 사용(목록에 실렸는지, 실제로 읽혔는지)을 보여 줍니다. `import`는 기록 기능이 생기기 전에 끝난 팀의 세션 파일에서 기록을 만듭니다(`--dry-run` 지원). `retro`는 한 팀의 회고 초안을 보여 줍니다. |
| `/team board` | 상태판 overlay를 엽니다. 팀 패널과 같은 테두리와 색을 쓰며, 위쪽 테두리의 탭으로 Teams·Team·Messages·Summary를 고릅니다. `↑↓` 선택·스크롤, `PgUp`/`PgDn` 페이지 이동, `enter` 팀 열기, `←→` 다른 팀, `tab`/`shift+tab` 보기 전환, `s` 답장, `a` 다른 저장소의 팀까지 보기·현재 저장소만 보기, `esc` 닫기입니다. 처음에는 패널처럼 현재 저장소(worktree 포함)의 팀만 보여 줍니다. `s`를 누르면 보드 아래쪽에 입력란이 열리고 위쪽 화면은 그대로 보이므로, Summary의 결정 사항을 보면서 답할 수 있습니다(`PgUp`/`PgDn` 스크롤, `enter` 보내기, `esc` 취소). 팀장 세션에서 자기 팀에 쓴 답장은 팀장에게 직접 한 말로 들어가고, 메인 세션이나 다른 팀으로 쓴 답장은 그 팀장의 우편함으로 갑니다. |
| `/team panel [on\|off\|reset]` · `ctrl+shift+t` · `alt+t` | 팀 패널을 켜거나 끕니다. 패널이 떠 있어도 입력은 그대로 할 수 있습니다. `reset`은 패널을 원래 위치로 되돌립니다. |
| `/team send lead@<team> <내용>` | 팀장에게 메시지를 보냅니다. |
| `/team collect <team>` | 팀 요약을 메인 세션으로 가져옵니다. 모델은 실행하지 않습니다. |
| `/team close <team> [--confirm-lead] [--confirm-unmerged] [--keep-worktree]` | 메인 세션(팀이 없는 pi)에서만 실행합니다. 팀장 pane에서 입력하면 메인 세션에서 실행하라는 안내가 나옵니다. worktree를 정리합니다. 병합되지 않은 branch는 지우지 않습니다. worktree의 `artifacts/`는 팀 archive(`teams/archive/<team>/artifacts/`)로 옮겨 남기고, 그 밖의 커밋하지 않은 변경이 있으면 닫지 않습니다. `--confirm-lead`는 팀장이 아직 떠 있을 때, `--keep-worktree`는 저장소 자체 절차로 worktree와 branch를 지우는 경우에 팀 기록과 `artifacts/`만 archive로 옮기고 worktree·branch·변경을 그대로 둡니다. 사용자가 요청하면 메인 모델도 `team_close` 도구로 닫을 수 있으며, 이때는 무엇이 지워지는지 보여 주는 확인 창에서 사용자가 승인해야 합니다. `/team` 하위 명령, 팀 ID, preset 이름과 close 옵션은 Tab으로 자동완성됩니다. |
| `/team resume <team>` | 프로세스가 끝난 팀장(잠자기, 충돌, 닫힌 pane)을 마지막 세션으로 다시 띄웁니다. 팀 pane이 셸 프롬프트에 있으면 그 pane에서 실행하고, 다른 프로세스가 돌고 있으면 실행할 명령만 보여 줍니다. 팀장은 `PI_TEAM_ROLE=lead`와 `PI_TEAM_ID`가 있어야 팀장으로 뜨므로, 팀 pane에서 그냥 `pi`로 세션을 재개하면 팀장이 아니라 일반 메인 세션이 됩니다. 이렇게 시작한 세션에는 경고가 뜹니다. |
| `/team cache` | 캐시 보존 설정과 최근 턴의 1시간 캐시 사용을 보여 줍니다(아래 「설치」의 캐시 설정 참고). |
| `/team clean [team] [--yes]` | 팀을 연 채로 다시 만들 수 있는 빌드 산출물만 지웁니다. 대상은 Git이 무시하고 추적 파일이 없는 `build`, `.build`, `.dart_tool`, `DerivedData`, `Pods`, `node_modules`, `.gradle`, `.cxx`, `target`, `dist`, `.next`, `.turbo`, `.expo`, `.svelte-kit` 폴더입니다(깊이 4까지, `artifacts/` 제외). 목록과 크기를 보여 주고 확인을 받은 뒤 지웁니다. `config/app.env`처럼 무시되는 설정 파일은 건드리지 않습니다. 작업 중인 구성원이 있으면 거절합니다. 팀장 세션에서는 팀을 생략할 수 있습니다. |
| `/team main [<preset>\|off] [--default]` | 메인 모드를 켜거나 끄고, 인자가 없으면 상태를 보여 줍니다. `--default`는 이 호스트의 새 세션에 적용할 기본값을 저장하거나 지웁니다. 이 값은 preset 없이 `/team start`를 실행할 때의 기본 preset이기도 합니다. `main.json`의 캐시 설정은 그대로 둡니다. |
| `/team routes [--team <id>] [--text]` | 라우터 설정 화면을 엽니다. 역할마다 다음 요청이 갈 모델·effort(NEXT), 예비 후보(FALLBACK), 지금 실행 중인 구성원의 모델(RUNNING)을 보여 주고, 임시 조정한 역할은 주황색입니다. 팀장(`orchestrator`) 줄은 팀장 세션의 실제 모델이며, 다른 세션에서는 볼 수만 있습니다. `↑↓` 역할, `←→` effort 한 단계, `m` 모델 고르기(이 호스트에서 로그인된 모델만), `r` 역할 되돌리기, `R` 전체 되돌리기, `tab` 대상 전환(메인 모드와 팀들), `esc` 닫기입니다. 바꾼 값은 바로 저장되어 다음 요청부터 적용됩니다. 실행 중인 구성원은 다음 요청에서 새 모델로 옮깁니다(이때 프롬프트 캐시를 한 번 새로 씁니다). `--text`나 print 모드에서는 표를 출력합니다. |
| `/team effort <role\|all> <level\|reset> [--team <id>]` | 역할의 effort(thinking 수준)를 임시로 바꿉니다. preset 파일은 바꾸지 않으며 다음 요청부터 적용됩니다. 팀장 세션의 `orchestrator`와 메인 모드의 `orchestrator`는 그 세션의 thinking 수준 자체를 바꿉니다. 메인 세션에서 `--team`으로 팀장 effort를 바꿀 수는 없으며, 팀장 pane에서 바꿉니다. |
| `/team model <role\|all> <provider/model[:level] 또는 별칭[:level]\|reset> [--team <id>]` | 역할이 가장 먼저 시도할 모델을 임시로 지정합니다(예: `opus:high`). 원래 후보는 그 뒤의 예비로 남습니다. 메인 모드와 팀장 세션의 `orchestrator`는 그 세션의 모델을 바로 바꿉니다(`/model`과 같습니다). 메인 세션에서 `--team`으로 팀장 모델을 바꿀 수는 없습니다. |
| `/team preset use <preset>\|reset [--team <id>]` | 팀의 모든 역할을 다른 preset의 같은 역할 후보 모델로 보냅니다(예: advanced 팀을 mix 모델로). 팀의 preset, 구성원 이름, 역할의 도구·스킬·프롬프트는 그대로 두고, 역할별 모델·effort 임시 조정은 지웁니다. 새 preset에 없는 역할은 원래 모델을 씁니다. 실행 중인 구성원은 다음 요청부터 옮깁니다. `reset`은 팀 preset의 모델로 되돌립니다. 메인 모드에서는 `/team main <preset>`을 씁니다. |
| `/team preset show [preset]` · `/team alias show` | preset(설명, 후보별 로그인·cooldown 상태, 잘못된 preset의 이유)과 별칭을 보여 줍니다. |

## 설정 파일

- preset: pi-team에 들어 있는 `presets.default.json` 위에 `~/.pi/agent/teams/presets.json`, 그 위에 저장소별 `<repo>/.pi/teams/presets.json`을 겹칩니다(아래 「preset 구조」).
- 메인 모드와 팀 시작의 기본 preset: `~/.pi/agent/teams/main.json`의 `preset`(`/team main <preset> --default`로 만듭니다)
- 별칭: `~/.pi/agent/teams/aliases.json`, 또는 `<repo>/.pi/teams/aliases.json`
- 시작 제외 목록: `~/.pi/agent/teams/start-ignore`, 또는 `<repo>/.pi/teams/start-ignore`(gitignore 문법)

### preset 구조

기본 preset은 저장소의 [`presets.default.json`](presets.default.json)에 있습니다. 파일은 세 부분으로 이루어집니다.

- **`models`:** 모델 별칭입니다. 예: `"opus": "anthropic/claude-opus-5-5"`, `"sol": "openai-codex/gpt-6.2-sol"`. 새 모델이 나오면 이 줄만 바꾸면 그 별칭을 쓰는 모든 preset에 반영됩니다.
- **`presets.base`:** 모든 역할(스킬, MCP, 프롬프트 등)을 한 번만 정의하는 추상 preset입니다. 역할의 `models`에는 실제 모델 대신 슬롯 이름(`@lead`, `@build`, `@deep`, `@scout`, `@vision`, `@write`, `@image`)을 적습니다.
- **나머지 preset:** `extends`로 상속하고, 슬롯(`slots`)과 바뀌는 역할(`roles`)만 적습니다. 역할에 `null`을 주면 그 역할을 뺍니다. 후보는 `별칭:사고수준`(예: `opus:high`)이나 `provider/model:사고수준`으로 적습니다.

| preset | 팀장(orchestrator) | 구성원 | 용도 |
|---|---|---|---|
| `mix` | opus:high → sol:xhigh | 구현은 Codex 우선(task sol:high → sonnet:high, 나머지 구현 역할 sol:medium → sonnet:medium, scout luna → haiku), 설계·검토·문서는 Claude 우선(opus:high → sol:high) | 두 계정을 고루 쓸 때 |
| `advanced` | fable:high → opus:high | `mix`와 같음 | 더 강한 팀장이 필요할 때 |
| `claude` | opus:high | sonnet·opus·haiku, image 역할 없음 | Claude 계정만 쓸 때(macbook 등) |
| `claude-advanced` | fable:xhigh → opus:xhigh | opus·sonnet, image 역할 없음 | Claude만 쓰면서 더 강한 팀이 필요할 때 |
| `codex` | sol:xhigh → astra:high | sol 중심, luna 정찰 | Codex 계정만 쓸 때 |
| `codex-advanced` | astra:xhigh → sol:xhigh | astra 중심 | Codex만 쓰면서 더 강한 팀이 필요할 때 |

호스트 파일과 저장소 파일은 `"version": 2`를 적고, 바꿀 부분만 씁니다. `models`는 별칭 단위로, 같은 이름의 preset은 슬롯과 역할 단위로 아래 층에 합쳐집니다.

```json
{
  "version": 2,
  "models": { "opus": "anthropic/claude-opus-6" },
  "presets": {
    "claude": { "slots": { "lead": ["fable:high", "opus:high"] } },
    "game": { "extends": "mix", "description": "Game work", "roles": { "modeler": null, "task": { "max": 5 } } }
  }
}
```

`version`이 없는 예전 형식(`{ "<preset>": { "<role>": {...} } }`)도 읽지만, 그 preset은 같은 이름의 기본 preset을 통째로 대체합니다. 그래서 별칭 변경이 반영되지 않습니다. 잘못된 preset이 하나 있어도 그 preset만 빠지고 나머지는 동작하며, 이유는 `/team preset show`에 나옵니다.

팀을 시작할 때 preset의 첫 후보에 로그인되어 있지 않은 역할이 있으면 경고합니다. 예를 들어 Claude만 로그인된 호스트에서 `mix`를 고르면 이 경고가 나오며, 이때는 `claude` preset을 쓰는 편이 맞습니다.

### 메인 모드

`/team main <preset>`은 메인 세션을 그 preset의 팀장처럼 씁니다.

- **모델 고정:** orchestrator 후보 가운데 로그인되어 있고 cooldown 중이 아닌 첫 실제 모델로 메인 모델을 바꾸고 사고 수준도 맞춥니다. virtual model이 아니므로 사고 수준 변경, pi의 캐시 데우기, prompt cache가 평소처럼 동작합니다.
- **역할 위임:** 그 preset의 역할이 `pi-team.<role>` agent로 등록됩니다(예: `pi-team.task`, `pi-team.scout`). 메인 모델은 `subagent`로 이 agent에 위임하고, 자식은 `team/<preset>.<role>` 후보 순서대로 모델을 고릅니다. 파일을 쓰는 역할도 쓸 수 있으며, 팀과 달리 별도 worktree 없이 현재 저장소에서 작업합니다.
- **실패 시 확인:** 메인 모델의 요청이 재시도 뒤에도 실패하면, 다음 orchestrator 후보로 바꿀지 묻습니다. 바꾸면 prompt cache를 잃어 다음 요청에서 대화 전체를 다시 보낸다는 점도 함께 알립니다. 사용 한도·속도 제한·과부하·인증 오류는 cooldown에 기록되어 팀에도 반영됩니다.
- **세션 단위:** 설정은 세션에 저장되어 재개해도 유지됩니다. `/team main <preset> --default`는 이 호스트의 새 세션에 자동으로 적용하며, `--model`로 시작한 세션에는 적용하지 않습니다.
- **팀 전용 agent 차단:** `pi-team.<preset>-<role>` 형태의 agent는 팀 안에서만 실행되므로 메인 세션에서 호출하면 막고 `pi-team.<role>`을 안내합니다.
- **팀장 모델 비노출:** 메인 세션의 `/model` 목록에는 `team/<preset>.orchestrator`가 나오지 않습니다. virtual model을 메인 모델로 쓰면 사고 수준이 무시되고 캐시 데우기가 꺼지며, 일반 서브에이전트가 모델을 찾지 못하기 때문입니다.

### 역할 설정

역할마다 `models`(fallback 순서, 슬롯 이름 가능) 외에 다음 속성을 쓸 수 있습니다.

| 속성 | 뜻 |
|---|---|
| `description` | 한 줄 설명. 팀장이 역할을 고를 때 보는 목록과 agent 설명에 들어갑니다. |
| `skills` | 팀원에게 줄 스킬 이름 목록. pi가 찾는 위치(`~/.agents/skills` 등)에 설치되어 있거나, pi-team 저장소의 `role-skills/`에 있어야 합니다. `role-skills/`의 스킬은 pi-team이 역할 전용으로 싣는 스킬입니다. 구성원 agent의 `skillPath`로만 전달되므로 메인 세션과 팀장의 스킬 목록에는 나오지 않고, 메인은 그 역할에 위임해서 씁니다(팀장은 `team_skills`로 찾아 다른 구성원에게 더해 줄 수 있습니다). 지금은 `animator`의 `opentoonz-native-animation`이 있습니다. 저장소가 `.omp/skills`, `.pi/skills`, `.agents/skills`에 둔 스킬은 이 목록과 상관없이 모든 팀원(메인 모드 구성원 포함)과 팀장에게 함께 보이고, 이름이 같은 일반 스킬보다 우선합니다. |
| `core` | 핵심 스킬 이름 목록. 본문 전체를 구성원 프롬프트에 처음부터 넣습니다. 스킬 하나가 곧 그 역할이 일하는 방법일 때만 씁니다(매 턴 실리므로 한두 개까지). 기본 preset에서는 `animator`의 `opentoonz-native-animation`이 핵심 스킬입니다. 찾지 못한 이름은 일반 `skills`처럼 목록에 실립니다. |
| `mcp` | 팀원 전용 MCP 서버 이름 목록. `blender`와 `rea`가 있습니다. |
| `tools`, `extensions`, `readOnly`, `max`, `prompt` | 도구 목록, 팀원 전용 확장, 읽기 전용 여부, 동시 실행 상한, 추가 프롬프트 |

```json
"modeler": {
  "models": ["@deep"],
  "description": "3D work in its own headless Blender",
  "skills": ["text-to-blender", "blender-modeling", "blender-uv-texturing"],
  "mcp": ["blender"]
}
```

팀장 프롬프트의 역할 목록에는 역할마다 `description`이 붙고, 그 아래에 자주 쓰는 역할을 언제 부를지 정한 안내가 이어집니다. 이 안내는 그 preset에 있는 역할만 다룹니다.
- scout: 첫 위임 전과, 코드·문서·로그의 사실로 결정되는 질문이 생길 때마다 부릅니다. `경로:줄` 근거를 받아 일하며, 명령을 실행하지 못하므로 빌드·테스트·git 이력은 task나 qa-tester에게 맡깁니다.
- task: 구현, 디버깅, 수정을 맡습니다. 설명이 더 잘 맞는 전문 역할이 있으면 그 역할에 맡깁니다.
- reviewer: 구성원이 코드를 바꾼 뒤, 사용자에게 완료를 보고하기 전에 부릅니다.
- qa-tester: 웹 UI를 브라우저에서 실행하고 확인할 때 부릅니다.
- vision: 스크린샷과 디자인 이미지를 판독할 때 부릅니다.
- art-reviewer: 아트, 합성, 모션 산출물(렌더, 스프라이트, 애니메이션 클립)을 완료로 보고하기 전에 부릅니다. 산출물, 기준 자료, 수용 기준을 넘기고, 모션이면 전 프레임 스트립과 정상 속도 클립도 넘깁니다. 읽기 전용이며 명령을 실행하지 못하므로, 영상은 프레임 이미지로 받아야 합니다.

팀원 전용 MCP 서버는 팀원이 처음 도구를 호출할 때 시작하고, 팀원 세션이 끝날 때 프로세스 그룹째 종료합니다(SIGTERM, 5초 뒤 SIGKILL). 도구를 쓰지 않는 팀원은 서버를 띄우지 않으며, 도구 정의는 `~/.cache/pi-team/mcp/<이름>-tools.json`에 캐시합니다.

`mcp: ["blender"]`인 팀원은 첫 Blender 호출 때 자기 전용 헤드리스 Blender와 [mcp-for-blender](https://github.com/ahujasid/mcp-for-blender) 서버를 빈 포트로 띄우고, 끝날 때 함께 종료합니다. 저장하지 않은 장면을 잃지 않도록 유휴 종료는 하지 않습니다. 메인 세션과 팀장은 Blender를 띄우지 않으며, 여러 팀원이 동시에 각자의 Blender를 쓸 수 있습니다. 서버 도구는 `mcp__blender__execute_blender_code`, `get_scene_info`, `look`, `search_assets`, `import_asset`, `get_addon_status` 이름으로 등록됩니다. 필요한 것은 PATH의 `blender`(macOS는 `/Applications/Blender.app`도 찾음), `uv`(`uvx`), `python3`입니다. mcp-for-blender는 시작할 때마다 최신판을 받고, 서버와 Blender 애드온은 같은 판을 씁니다. Blender 출력은 `~/.cache/pi-team/blender-mcp/`에 남습니다.

`mcp: ["rea"]`인 팀원은 [REA](https://github.com/morluto/rea)(`rea mcp`)를 씁니다. REA 도구는 260개가 넘고 정의가 수 MB이므로, 팀원에게는 중계 도구 세 개만 등록합니다. `rea_tools`는 이름과 설명으로 도구를 검색하고, `rea_tool_schema`는 한 도구의 입력 스키마를 보여 주며, `rea_call`은 도구 하나를 실행합니다. REA는 첫 호출 때 시작하고, 10분 동안 호출이 없으면 종료한 뒤 다음 호출 때 다시 시작합니다(열었던 대상은 닫히며, 결과에 재시작 안내가 붙습니다). 유휴 시간은 `PI_TEAM_REA_IDLE_MINUTES`로 바꾸고, `0`이면 유휴 종료를 끕니다. 호출 하나의 제한 시간은 1시간입니다. 필요한 것은 `rea`(`brew install rea`)이고, 네이티브 디컴파일에는 Ghidra와 JDK 25 이상이 필요합니다. 확장은 `GHIDRA_INSTALL_DIR`가 없으면 Homebrew(`opt/ghidra/libexec`)와 `/opt/ghidra`, `/usr/share/ghidra`에서 Ghidra를 찾고, `JAVA_HOME`이 25 미만이면 Homebrew `openjdk*`, `/Library/Java/JavaVirtualMachines`, `/usr/lib/jvm`에서 가장 새 JDK 25 이상을 골라 넘깁니다. Ghidra JVM은 REA가 종료할 때 함께 정리됩니다.

### 사용량을 줄이는 기본 동작

팀은 같은 문맥을 턴마다 다시 읽기 때문에, 사용량은 대부분 캐시 읽기와 캐시 재작성에서 나옵니다. pi-team은 다음을 기본으로 적용합니다.

- **프롬프트 캐시 보존:** 팀장은 `PI_CACHE_RETENTION=long`(1시간)으로 실행됩니다. Anthropic의 기본 캐시는 5분이라, 구성원을 기다리느라 5분 넘게 쉰 팀장은 깨어날 때마다 문맥 전체를 다시 썼습니다. 팀장은 실제 모델로 돌므로 pi의 유휴 캐시 데우기도 동작하며, 데우기는 캐시 수명에 맞춰 1시간 가까이 되었을 때 일어납니다. 구성원은 `PI_SUBAGENT_CACHE_RETENTION=short`(5분)로 실행됩니다. 구성원은 5분 넘게 쉬는 일이 드물어, 1시간 캐시의 쓰기 할증(입력 단가의 2배, 5분은 1.25배)이 아끼는 재기록보다 컸습니다(macbook 구성원 세션 105개 기준 할증 약 5.2M, 절약 약 2.2M 입력 토큰 상당). 기기 시험이나 긴 빌드처럼 오래 기다리는 구성원이 많으면 `PI_SUBAGENT_CACHE_RETENTION=long`을 지정합니다. 두 값 모두 이미 지정되어 있으면 그 값을 씁니다.
- **Herdr 복원 세션:** 재부팅이나 Herdr 서버 재시작 뒤 Herdr는 pane을 `pi --session <file>`로만 복원합니다. 그래서 팀장 세션이 팀 설정 없이 일반 세션으로 뜹니다(팀 우편, 팀장 프롬프트, 팀장 압축, 1시간 캐시가 모두 빠짐). pi-team은 이런 세션이 시작되면 그 프로세스의 캐시 보존을 팀장과 같게 맞추고, 팀장으로 다시 시작할지 묻습니다. 승인하면 pi가 종료된 뒤 같은 pane에서 팀 설정으로 같은 세션을 다시 엽니다.
- **구성원이 받는 것(세 층):** 구성원은 다음을 받습니다.
  - **프로젝트 규칙:** 저장소의 `AGENTS.md`와 사용자 전역 `~/.pi/agent/AGENTS.md`를 항상 전체로 받습니다(pi-subagents의 `inheritProjectContext`·`inheritGlobalContext`). pi-subagents의 직접 정의 agent는 기본으로 이 파일들을 받지 않아서, 예전 구성원은 저장소 규칙을 하나도 모른 채 코드를 고쳤습니다. 크기가 커도 빼지 않으므로, AGENTS.md가 크면 구성원의 매 턴에 그만큼 실립니다(캐시 읽기). 사용자 승인이나 위임이 필요한 규칙은 구성원이 직접 하지 않고 보고합니다.
  - **역할 지식:** 핵심 스킬(`core`)은 본문이 처음부터 프롬프트에 있습니다. 목록 스킬은 구성원이 첫 명령·수정 전에 골라야 합니다. 목록의 스킬 하나를 `read`로 끝까지 읽거나(`offset`·`limit`을 준 부분 읽기는 세지 않습니다), `skill_skip`으로 맞는 스킬이 없는 이유를 선언하기 전에는 `bash`·`edit`·`write`·MCP 같은 도구 호출이 거절됩니다. `read`·`grep`·`find`·`ls`와 팀 우편은 열려 있으며, 읽기만 하는 역할에는 적용되지 않습니다. 선언한 이유는 실행 기록과 회고에 남습니다. 저장소 설정은 필요 없습니다. 따르는 스킬이 요구하는 절차와 문서는 지시문의 제한 시간보다 우선합니다. 시간이 모자라면 구성원은 절차를 건너뛰지 않고 작업 범위를 줄여 남은 일을 보고하며, 부분만 읽거나 건너뛴 스킬·문서를 보고의 Checks에 적습니다. 실행 기록은 `limit`·`offset`을 준 스킬 읽기와 `wc`·`grep`·`head` 같은 셸 접근을 부분 읽기로 따로 남기고, `/team stats <role>`의 읽힘 횟수에는 끝까지 읽은 경우만 셉니다. 기록은 스킬을 읽을 때마다 저장되므로 실행 중인 구성원의 읽기도 보입니다. 회고 초안은 부분으로만 읽은 스킬을 「read only partly」로 표시합니다.
  - **과제:** 팀장이나 메인의 지시문입니다. 구성원이 프로젝트 규칙을 직접 받으므로 지시문에 규칙을 옮겨 적지 않습니다.
  - 규칙이 서로 어긋나면 프로젝트 규칙, 저장소 스킬, 일반 스킬 순으로 따릅니다. 메인 모드 구성원(`pi-team.<role>`)도 같습니다.
- **팀장 스킬 제한:** 팀장은 `--no-skills`로 실행되고 `fluent-korean`, `herdr-agent-messenger`, `pi-subagents`와 저장소 자체 스킬만 받습니다. 전체 스킬 목록은 매 요청에 4만 자 넘게 실렸습니다. orchestrator 역할에 `skills`를 지정하면 그 목록을 쓰고, `["*"]`이면 모든 스킬을 줍니다.
- **팀장 모델:** 팀장은 메인 모드처럼 실제 모델로 실행됩니다. 처음 시작할 때 orchestrator 후보 가운데 로그인되어 있고 cooldown 중이 아닌 첫 모델과 그 사고 수준을 골라 세션 기록(`pi-team-lead-model`)에 남깁니다. 재개한 세션은 마지막으로 쓰던 모델(사용자가 `/model`로 바꾼 모델 포함)을 그대로 씁니다. 요청이 재시도 뒤에도 실패하면 자동으로 바꾸지 않고, 다음 후보로 바꿀지 사용자에게 묻습니다. 바꾸면 prompt cache를 잃기 때문입니다. 예전 코드로 만든 팀(가상 모델 `team/<preset>.orchestrator`로 돌던 팀장)은 재개할 때 같은 방식으로 실제 모델을 고릅니다. 구성원은 지금처럼 역할별 가상 모델로 fallback 체인을 따릅니다.
- **팀장 문맥 관리:** 팀장은 메인 모드처럼 작은 일은 직접 하고 나머지는 맡깁니다. 이미 아는 파일 한두 개를 읽거나 몇 줄을 고치는 일은 직접 합니다. 구성원의 설명이나 스킬이 다루는 분야(Blender, Flutter, Android·Kotlin, iOS·Swift, 웹 UI, 브라우저 검증, 이미지, 보안, 역공학 등)의 일은 그 구성원에게 맡깁니다. 빌드, 테스트, 기기·시뮬레이터 실행, 브라우저 캡처, 긴 로그는 명령 하나라도 항상 맡깁니다. 직접 하던 일이 파일 서너 개를 넘게 읽게 되거나 같은 문제를 세 번째 고치게 되면, 알아낸 내용을 지시문에 담아 구성원에게 넘깁니다. 같은 파일을 이어서 다루는 후속 작업은 새 구성원 대신 이전 구성원을 재개(`subagent` action `resume`)하게 합니다. 재개는 `async`로 띄운 구성원에서 동작하며, 실행 ID는 `status`나 `children.list`로 확인합니다.
- **팀장 자동 압축:** 팀장 문맥이 20만 토큰을 넘으면 압축합니다. 작업 도중에도 도구 결과가 나온 턴이 끝날 때마다 판단하고, 다음 요청 전에 요약을 써서 진행 중인 작업을 끊지 않습니다. 응답을 마치고 쉴 때도 한 번 더 판단합니다. pi 자체 압축은 컨텍스트 창 끝(1M 모델이면 약 98만 토큰)에서야 동작하고, 예전 pi-team은 쉴 때만 판단해서 팀장 문맥이 45만 토큰까지 커졌습니다. 압축한 뒤에도 문맥이 임계값을 넘으면 임계값의 4분의 1만큼 더 쌓일 때까지 다시 압축하지 않습니다. 임계값은 `PI_TEAM_LEAD_COMPACT_TOKENS`로 바꾸고, `0`이면 끕니다. 컨텍스트 창이 이보다 작으면 창의 80%가 임계값입니다. TUI 세션의 자동 handoff 확장(예: 창의 40%에서 새 세션)을 함께 쓰면, 팀장에서는 pi-team 압축이 먼저 돌도록 handoff 임계값을 팀장 압축 임계값보다 높게 둡니다. 1M 창 팀장은 20만 압축이 40% handoff(40만)보다 먼저 돌지만, 27.2만 창(Codex 등)에서는 40% handoff(약 10.9만)가 먼저 걸립니다.
- **구성원 자동 압축:** 구성원도 도구 결과가 나온 턴이 끝날 때 문맥이 실행 중인 모델 컨텍스트 창의 20%를 넘으면 압축합니다. 1M 모델이면 팀장과 같은 20만이고, 27.2만 모델은 약 5.4만, 50만 모델은 10만입니다. 비율은 `PI_TEAM_MEMBER_COMPACT_RATIO`로 바꾸고, `0`이면 끕니다. 구성원은 run이 끝나면 종료하므로 쉴 때 압축은 하지 않습니다.
- **압축 실패에 대한 안전장치:** 턴 사이 압축은 run을 잠시 붙잡으므로, 요약 요청이 실패하거나 사용자가 중단하거나 제한 시간(`PI_TEAM_COMPACT_TIMEOUT_MS`, 기본 3분)을 넘기면 압축을 건너뛰고 전체 문맥으로 그대로 이어 갑니다. 두 번 연속 실패하면 그 세션에서는 턴 사이 압축을 끕니다.
- **팀장 직접 작업 경고:** 팀장이 10분 안에 `bash`, `read`, `edit`, `write`, `grep`, `find`, `ls`를 10번 이상 직접 실행하면, 작은 일을 넘어섰으니 구성원에게 넘기라는 메시지를 팀장에게 끼워 넣습니다(steer). 같은 메시지가 화면에도 보입니다. 경고는 30분에 한 번까지입니다. `team_*`, `subagent`, `lesson_*` 같은 조율 도구와 SKILL.md 읽기는 세지 않습니다. 횟수는 `PI_TEAM_LEAD_DIRECT_WARN`으로 바꾸고, `0`이면 끕니다. 팀장이 직접 실행한 도구 호출은 그때마다 팀장 문맥 전체를 다시 읽습니다. 예를 들어 25만 토큰 문맥으로 bash를 247번 실행한 팀장은 이 비용이 팀장 비용의 78%였습니다.
- **팀장 프롬프트 갱신:** 팀장 프롬프트(`lead-prompt.md`)는 팀장이 시작할 때마다 지금 코드의 지침으로 다시 씁니다. pi는 확장을 불러온 뒤에 `--append-system-prompt` 파일을 읽으므로, 예전에 만든 팀도 팀장을 다시 띄우기만 하면 새 지침을 받습니다. 내용이 바뀌었으면 시작할 때 알림을 띄웁니다.
- **간결한 `team_peers`:** 팀장과 실행 중인 구성원의 키·역할·상태·모델·현재 도구, 끝난 구성원의 키와 상태만 반환합니다.
- **구성원 읽기 규칙:** 큰 파일은 범위를 정해 읽고, 이미 읽은 파일과 이미지는 바뀌지 않았으면 다시 읽지 않게 합니다.

### 디스크와 오래 방치된 팀

- **크기 표시:** `/team board`의 팀 카드에 worktree 크기와 그 가운데 다시 만들 수 있는 산출물 크기를 보여 줍니다. `du`는 큰 트리에서 몇 초가 걸리므로 백그라운드에서 계산해 `teams/<team>/disk.json`에 10분 동안 캐시하고, 2초마다 갱신하는 패널에는 넣지 않습니다. 산출물이 1G를 넘으면 `/team clean`을 안내합니다.
- **방치 경고:** 팀장이 24시간(`PI_TEAM_STALE_HOURS`) 넘게 꺼져 있는 열린 팀은 메인 세션을 시작할 때 한 번 알립니다. 패널과 board는 「lead offline 2d」처럼 꺼진 시간을 보여 주고, 하루가 넘으면 빨간색으로 표시합니다.
- **산출물 위치:** 팀장과 구성원은 메모, 캡처, 증거를 팀 worktree의 `artifacts/`에 둡니다. 인계 문서가 메인 checkout 같은 바깥 폴더를 지정해도 원본은 `artifacts/`에 두고 끝날 때 복사합니다. 바깥 폴더는 팀이 도는 동안 정리될 수 있기 때문입니다. `/team close`는 `artifacts/`를 archive로 옮깁니다.

### 착수 점검과 지시문 양식

팀장은 첫 위임 전에 목표를 점검합니다. 결과물, 범위와 범위 밖, 완료 기준, 제약, 모르는 점을 짧게 정리합니다. 모르는 점 가운데 답에 따라 만들 것이 달라지거나 재작업이 생길 수 있는 것은 사용자에게 묻습니다. 질문은 3개 이하이고, 문자 선택지와 추천 기본값을 붙입니다. 나머지는 기본값을 가정하고 그 가정을 밝힌 뒤 진행합니다. 저장소를 보면 풀리는 질문은 scout에게 맡깁니다. 목표에 이미 이 내용이 있으면 점검은 건너뜁니다.

구성원에게 주는 지시문은 Goal, Background(사용자 원문 포함), Read first, Do, Do not(쓰기 범위), Done when(완료 기준과 확인 방법), Limits(제한 시간, 중간 기록, 산출물은 작업 트리의 `artifacts/`), Report 순서의 제목을 따릅니다. 역할에 따라 조사는 질문과 `경로:줄` 근거, 검토는 P0~P2와 판정, 산출물은 경로를 더합니다. 구성원은 제한 시간 안에 보고를 남기고, Result, Checks(실행한 것과 실행하지 않은 것), Open issues, Changed files, Artifacts 순서로 보고합니다.

### 실행 기록과 스킬 판단

pi-team은 팀장과 구성원이 실행될 때마다 `~/.pi/agent/teams/stats/<팀>-<키>-<세션>.json`에 기록을 남깁니다. 기록에는 역할, 작업 첫 줄, 모델, 턴 수, 토큰과 비용, 최대 문맥, 도구별 호출 수(SKILL.md 읽기 제외), 목록에 실린 스킬과 그 글자 수, 실제로 읽은 스킬(몇 번째 턴에 몇 자)이 들어갑니다. `/team stats orchestrator`는 팀장의 실행당 직접 작업 수도 보여 줍니다. 팀을 닫아도 기록은 남으므로, 역할과 스킬 구성을 그때그때 짐작하지 않고 쌓인 사용 기록으로 판단할 수 있습니다.

`/team stats`는 이 기록으로 스킬을 다음처럼 분류합니다. 판단에는 같은 역할의 실행이 5회 이상 필요합니다.

- **adopted:** 목록에 실린 실행의 절반 이상에서 읽힌 스킬
- **retire candidates:** 5회 이상 목록에 실렸지만 한 번도 읽히지 않은 스킬. 매 턴 설명만 차지하므로 역할에서 빼는 것을 검토합니다.
- **assign candidates:** 목록에 없는데 구성원이 직접 찾아 읽은 스킬. 역할에 넣는 것을 검토합니다.

presets는 자동으로 바꾸지 않습니다. 결과를 보고 사용자가 고칩니다.

팀장은 `team_route` 도구로 `/team routes`와 같은 일을 합니다. `show`로 역할별 다음 모델·예비 후보·실행 중인 구성원을 보고(preset 파일을 읽지 않습니다), `model`·`effort`로 역할 하나나 전체를, `preset`으로 다른 preset의 모델 배치를 구성원 역할에 적용합니다(팀장은 자기 모델을 유지합니다). `orchestrator`의 `model`·`effort`는 팀장 세션의 모델과 사고 수준을 직접 바꿉니다. 사용자가 요청한 변경은 사용자 원문을 `approval`로 넘겨야 하며, pi-team은 그 문구가 팀장 세션의 사용자 메시지나 메인 세션이 보낸 우편에 실제로 있는지 확인합니다. 승인 없이 팀장 판단만으로는 역할의 effort를 낮추거나, 그 역할의 후보 안에 있는 모델을 같거나 낮은 effort로 앞에 두는 것만 할 수 있습니다. preset 적용과 되돌리기는 항상 승인이 필요합니다. 변경은 사용자에게 한 줄 알림으로 보이고, 누가 어떤 근거로 바꿨는지 팀 ledger에 남아 `summary.md`의 「Routing changes」에 실립니다. 사용자가 `/team routes`·`/team model`·`/team effort`·`/team preset`으로 바꾼 것도 같이 기록됩니다.

팀장은 `team_skills` 도구로 설치된 스킬을 검색합니다. 결과에는 스킬 크기와 해당 역할의 과거 읽힘 비율이 함께 나옵니다. 필요한 구성원 한 명에게만 `subagent`의 `skill` 옵션으로 스킬을 더해 줍니다. 이 목록은 역할의 기본 스킬을 대체하므로 기본 스킬도 함께 넘깁니다. 팀 실행 중에는 새 스킬을 설치하지 않습니다. 새 스킬은 `npx skills find <키워드>`로 찾아 사용자 승인 뒤 `npx skills add`로 설치합니다.

### 팀 회고

구성원 기록에는 지시문이 양식을 따랐는지(빠진 제목)와 최종 보고가 양식을 따랐는지도 남습니다. 양식 제목이 하나도 없는 지시문은 「양식 밖」으로, 최종 응답이 거의 없는 실행은 「보고 없음」으로 따로 셉니다.

팀장이 `team_report`를 status `done`으로 호출하면 pi-team이 회고 초안을 만들어 돌려주고, 팀 디렉터리의 `retro.md`에 저장합니다. 팀을 닫을 때도 최종 기록으로 다시 씁니다. 초안은 모델 토큰을 쓰지 않는 계산입니다. 구성원별 턴·문맥·비용·읽은 스킬과 다음 신호를 담습니다.

- 같은 역할을 여러 번 새로 띄웠는지(재개로 줄일 수 있었는지)
- 다른 팀의 같은 역할보다 비용이 크게 다른지
- 한 번도 읽히지 않은 스킬을 많이 싣고 있는지
- 보고 없이 끝난 구성원과, 그 지시문에 Limits가 있었는지
- 양식 밖의 지시문과 보고 수
- 역할에 없는 스킬을 구성원이 찾아 읽었는지
- 팀장이 직접 실행한 작업 도구 호출이 20번 이상인지(도구별 횟수와 최대 문맥)

팀장은 초안을 보고, 앞으로의 팀 구성이나 지시 방식을 바꿔야 할 패턴만 autolearn 교훈으로 남깁니다(주제 `team-roles` 또는 저장소의 `proj-` 주제). 설치된 스킬로 채울 수 없는 지식이 부족했다면 `npx skills find`로 후보를 찾아 요약에 적고, 설치는 하지 않습니다.

Herdr 사이드바에 팀 정보를 보이려면 `~/.config/herdr/config.toml`에 토큰 줄을 추가하고 `herdr server reload-config`를 실행합니다.

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "agent"],
  [{ token = "$team", fg = "#d4c090", bold = true }],
  [{ token = "$team_now", fg = "#9ca3b0" }],
]

[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["branch", "git_status"], [{ token = "$team_now", fg = "#9ca3b0" }]]
```

자세한 형식은 [`docs/DESIGN.md`](docs/DESIGN.md)를 참고하세요.

## 개발

```sh
npm install        # 타입 검사용 devDependencies(pi 1.6.0 패키지 사본, TypeScript)
npm run typecheck
```

pi가 제공하는 패키지(`@earendil-works/*`, `typebox`)는 `peerDependencies`로 선언합니다. `devDependencies`의 사본은 타입 검사와 LSP에만 쓰이며, pi는 실행할 때 자기 사본을 연결합니다.

## 라이선스

MIT
