# pi-team

`pi-team`은 [pi](https://pi.dev) 1.6+ 확장입니다. 필요할 때만 서브에이전트 **팀**을 띄워 작업을 맡깁니다. 팀마다 다음이 따로 주어집니다.

- git worktree 하나와 branch `pi-team/<team>`
- 사용자가 직접 대화하는 **팀장**(대화형 pi 세션)
- 팀장이 [pi-subagents](https://www.npmjs.com/package/pi-subagents)로 위임하는 역할별 팀원(task, scout, reviewer, vision, image 등)

메인 pi 세션의 모델과 도구는 바뀌지 않습니다. 설계 전문은 [`docs/DESIGN.md`](docs/DESIGN.md)에 있습니다.

## 주요 기능

- **역할 → 모델 preset:** 각 역할은 virtual model(`team/<preset>.<role>`)로 등록되며, fallback 체인과 cooldown을 따라 모델을 고릅니다.
- **팀 안 메시징:** 팀원끼리 파일 mailbox로 메시지를 주고받고, `replyTo`로 스레드를 잇습니다. 다른 팀과는 팀장끼리만 주고받습니다.
- **`/team board`:** 모든 팀의 목표, 각 worktree, 구성원별 실제 모델·상태·현재 도구, 메시지와 요약을 보여 주는 overlay입니다. widget도 함께 표시합니다.
- **팀 패널(`ctrl+shift+t`·`alt+t`):** 대화를 계속하면서 볼 수 있도록 화면 오른쪽에 떠 있는 패널입니다. 팀마다 진행 요약, 목표, 메인이 마지막으로 보낸 위임, 팀장과 팀원이 지금 하는 일과 모델, 마지막 메시지를 보여 줍니다. fullscreen 모드(pi 기본값)에서는 제목 줄을 마우스로 끌어 옮길 수 있고, 옮긴 위치는 기억합니다.
- **Herdr 연동:** [Herdr](https://herdr.dev) 안에서 실행하면 팀마다 `herdr worktree create`로 workspace를 만들고 팀장을 실행합니다. Herdr 밖에서는 worktree만 만들고 팀장 실행 명령을 안내합니다.
- **팀 별칭:** 「그래픽 팀에게 위임해 줘」처럼 자연어로 팀을 지정해 위임할 수 있습니다.
- **팀 아이콘과 Herdr 표시:** 팀마다 아이콘(별칭의 `icon`, `--icon`, 또는 기본 동물 이모지)과 설명이 붙습니다. Herdr 안의 팀장은 사이드바용 토큰 `$team`(무슨 팀인지)과 `$team_now`(지금 하는 일)를 보고합니다.

## 설치

```sh
pi install npm:pi-subagents
git clone https://github.com/zerodice0/pi-team
pi install ./pi-team
# 선택: image 역할(Codex OAuth)
npm i --prefix ~/.pi/agent/teams/vendor pi-codex-image-gen@0.3.2
```

## 사용법

| 명령 | 설명 |
|---|---|
| `/team start <preset or alias> [--name X] [--base REF] [--icon 🎨] -- <목표>` | 팀을 만들고 팀장을 띄웁니다. |
| `/team delegate <alias> -- <작업>` | 별칭에 해당하는 기존 팀에 작업을 보내고, 팀이 없으면 새로 만듭니다. |
| `/team stats [role]` · `/team stats import` | 역할별 실행 기록(턴 수, 최대 문맥, 캐시 읽기, 비용)과 스킬 사용(목록에 실렸는지, 실제로 읽혔는지)을 보여 줍니다. `import`는 기록 기능이 생기기 전에 끝난 팀의 세션 파일에서 기록을 만듭니다(`--dry-run` 지원). |
| `/team board` | 상태판 overlay를 엽니다. 팀 패널과 같은 테두리와 색을 쓰며, 위쪽 테두리의 탭으로 Teams·Team·Messages·Summary를 고릅니다. `↑↓` 선택·스크롤, `PgUp`/`PgDn` 페이지 이동, `enter` 팀 열기, `←→` 다른 팀, `tab`/`shift+tab` 보기 전환, `s` 팀장에게 메시지, `esc` 닫기입니다. |
| `/team panel [on\|off\|reset]` · `ctrl+shift+t` · `alt+t` | 팀 패널을 켜거나 끕니다. 패널이 떠 있어도 입력은 그대로 할 수 있습니다. `reset`은 패널을 원래 위치로 되돌립니다. |
| `/team send lead@<team> <내용>` | 팀장에게 메시지를 보냅니다. |
| `/team collect <team>` | 팀 요약을 메인 세션으로 가져옵니다. 모델은 실행하지 않습니다. |
| `/team close <team> [--confirm-unmerged]` | worktree를 정리합니다. 병합되지 않은 branch는 지우지 않습니다. |
| `/team preset show` · `/team alias show` | preset과 별칭을 보여 줍니다. |

## 설정 파일

- preset: `~/.pi/agent/teams/presets.json`, 또는 저장소별 `<repo>/.pi/teams/presets.json`
- 별칭: `~/.pi/agent/teams/aliases.json`, 또는 `<repo>/.pi/teams/aliases.json`
- 시작 제외 목록: `~/.pi/agent/teams/start-ignore`, 또는 `<repo>/.pi/teams/start-ignore`(gitignore 문법)

### 역할 설정

역할마다 `models`(fallback 순서) 외에 다음 속성을 쓸 수 있습니다.

| 속성 | 뜻 |
|---|---|
| `description` | 한 줄 설명. 팀장이 역할을 고를 때 보는 목록과 agent 설명에 들어갑니다. |
| `skills` | 팀원에게 줄 스킬 이름 목록. pi가 찾는 위치(`~/.agents/skills` 등)에 설치되어 있어야 합니다. |
| `mcp` | 팀원 전용 MCP 서버 이름 목록. `blender`와 `rea`가 있습니다. |
| `tools`, `extensions`, `readOnly`, `max`, `prompt` | 도구 목록, 팀원 전용 확장, 읽기 전용 여부, 동시 실행 상한, 추가 프롬프트 |

```json
"modeler": {
  "models": ["openai-codex/gpt-6.2-sol:high", "anthropic/claude-opus-5-5:high"],
  "description": "3D work in its own headless Blender",
  "skills": ["text-to-blender", "blender-modeling", "blender-uv-texturing"],
  "mcp": ["blender"]
}
```

팀원 전용 MCP 서버는 팀원이 처음 도구를 호출할 때 시작하고, 팀원 세션이 끝날 때 프로세스 그룹째 종료합니다(SIGTERM, 5초 뒤 SIGKILL). 도구를 쓰지 않는 팀원은 서버를 띄우지 않으며, 도구 정의는 `~/.cache/pi-team/mcp/<이름>-tools.json`에 캐시합니다.

`mcp: ["blender"]`인 팀원은 첫 Blender 호출 때 자기 전용 헤드리스 Blender와 [mcp-for-blender](https://github.com/ahujasid/mcp-for-blender) 서버를 빈 포트로 띄우고, 끝날 때 함께 종료합니다. 저장하지 않은 장면을 잃지 않도록 유휴 종료는 하지 않습니다. 메인 세션과 팀장은 Blender를 띄우지 않으며, 여러 팀원이 동시에 각자의 Blender를 쓸 수 있습니다. 서버 도구는 `mcp__blender__execute_blender_code`, `get_scene_info`, `look`, `search_assets`, `import_asset`, `get_addon_status` 이름으로 등록됩니다. 필요한 것은 PATH의 `blender`(macOS는 `/Applications/Blender.app`도 찾음), `uv`(`uvx`), `python3`입니다. mcp-for-blender는 시작할 때마다 최신판을 받고, 서버와 Blender 애드온은 같은 판을 씁니다. Blender 출력은 `~/.cache/pi-team/blender-mcp/`에 남습니다.

`mcp: ["rea"]`인 팀원은 [REA](https://github.com/morluto/rea)(`rea mcp`)를 씁니다. REA 도구는 260개가 넘고 정의가 수 MB이므로, 팀원에게는 중계 도구 세 개만 등록합니다. `rea_tools`는 이름과 설명으로 도구를 검색하고, `rea_tool_schema`는 한 도구의 입력 스키마를 보여 주며, `rea_call`은 도구 하나를 실행합니다. REA는 첫 호출 때 시작하고, 10분 동안 호출이 없으면 종료한 뒤 다음 호출 때 다시 시작합니다(열었던 대상은 닫히며, 결과에 재시작 안내가 붙습니다). 유휴 시간은 `PI_TEAM_REA_IDLE_MINUTES`로 바꾸고, `0`이면 유휴 종료를 끕니다. 호출 하나의 제한 시간은 1시간입니다. 필요한 것은 `rea`(`brew install rea`)이고, 네이티브 디컴파일에는 Ghidra와 JDK 25 이상이 필요합니다. 확장은 `GHIDRA_INSTALL_DIR`가 없으면 Homebrew(`opt/ghidra/libexec`)와 `/opt/ghidra`, `/usr/share/ghidra`에서 Ghidra를 찾고, `JAVA_HOME`이 25 미만이면 Homebrew `openjdk*`, `/Library/Java/JavaVirtualMachines`, `/usr/lib/jvm`에서 가장 새 JDK 25 이상을 골라 넘깁니다. Ghidra JVM은 REA가 종료할 때 함께 정리됩니다.

### 사용량을 줄이는 기본 동작

팀은 같은 문맥을 턴마다 다시 읽기 때문에, 사용량은 대부분 캐시 읽기와 캐시 재작성에서 나옵니다. pi-team은 다음을 기본으로 적용합니다.

- **1시간 프롬프트 캐시:** 팀장은 `PI_CACHE_RETENTION=long`으로 실행되고, 구성원도 이 값을 물려받습니다. Anthropic의 기본 캐시는 5분이라, 구성원을 기다리느라 5분 넘게 쉰 팀장은 깨어날 때마다 문맥 전체를 다시 썼습니다. pi의 유휴 캐시 데우기는 팀의 가상 모델에서는 동작하지 않습니다. 이미 `PI_CACHE_RETENTION`을 지정했다면 그 값을 씁니다.
- **팀장 스킬 제한:** 팀장은 `--no-skills`로 실행되고 `fluent-korean`, `herdr-agent-messenger`, `pi-subagents`와 저장소 자체 스킬만 받습니다. 전체 스킬 목록은 매 요청에 4만 자 넘게 실렸습니다. orchestrator 역할에 `skills`를 지정하면 그 목록을 쓰고, `["*"]`이면 모든 스킬을 줍니다.
- **팀장 문맥 관리:** 팀장 프롬프트는 소스·로그·이미지를 직접 읽거나 빌드·테스트를 직접 하지 말고 구성원에게 맡기라고 지시합니다. 같은 파일을 이어서 다루는 후속 작업은 새 구성원 대신 이전 구성원을 재개(`subagent` action `resume`)하게 합니다. 재개는 `async`로 띄운 구성원에서 동작하며, 실행 ID는 `status`나 `children.list`로 확인합니다.
- **팀장 자동 압축:** 팀장이 한 차례 응답을 마치고 쉴 때 문맥이 20만 토큰을 넘으면 압축합니다. 임계값은 `PI_TEAM_LEAD_COMPACT_TOKENS`로 바꾸고, `0`이면 끕니다.
- **간결한 `team_peers`:** 팀장과 실행 중인 구성원의 키·역할·상태·모델·현재 도구, 끝난 구성원의 키와 상태만 반환합니다.
- **구성원 읽기 규칙:** 큰 파일은 범위를 정해 읽고, 이미 읽은 파일과 이미지는 바뀌지 않았으면 다시 읽지 않게 합니다.

### 실행 기록과 스킬 판단

pi-team은 팀장과 구성원이 실행될 때마다 `~/.pi/agent/teams/stats/<팀>-<키>-<세션>.json`에 기록을 남깁니다. 기록에는 역할, 작업 첫 줄, 모델, 턴 수, 토큰과 비용, 최대 문맥, 목록에 실린 스킬과 그 글자 수, 실제로 읽은 스킬(몇 번째 턴에 몇 자)이 들어갑니다. 팀을 닫아도 기록은 남으므로, 역할과 스킬 구성을 그때그때 짐작하지 않고 쌓인 사용 기록으로 판단할 수 있습니다.

`/team stats`는 이 기록으로 스킬을 다음처럼 분류합니다. 판단에는 같은 역할의 실행이 5회 이상 필요합니다.

- **adopted:** 목록에 실린 실행의 절반 이상에서 읽힌 스킬
- **retire candidates:** 5회 이상 목록에 실렸지만 한 번도 읽히지 않은 스킬. 매 턴 설명만 차지하므로 역할에서 빼는 것을 검토합니다.
- **assign candidates:** 목록에 없는데 구성원이 직접 찾아 읽은 스킬. 역할에 넣는 것을 검토합니다.

presets는 자동으로 바꾸지 않습니다. 결과를 보고 사용자가 고칩니다.

팀장은 `team_skills` 도구로 설치된 스킬을 검색합니다. 결과에는 스킬 크기와 해당 역할의 과거 읽힘 비율이 함께 나옵니다. 필요한 구성원 한 명에게만 `subagent`의 `skill` 옵션으로 스킬을 더해 줍니다. 이 목록은 역할의 기본 스킬을 대체하므로 기본 스킬도 함께 넘깁니다. 팀 실행 중에는 새 스킬을 설치하지 않습니다. 새 스킬은 `npx skills find <키워드>`로 찾아 사용자 승인 뒤 `npx skills add`로 설치합니다.

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
