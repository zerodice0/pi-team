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
| `/team start <preset or alias> [--name X] [--base REF] -- <목표>` | 팀을 만들고 팀장을 띄웁니다. |
| `/team delegate <alias> -- <작업>` | 별칭에 해당하는 기존 팀에 작업을 보내고, 팀이 없으면 새로 만듭니다. |
| `/team board` | 상태판 overlay를 엽니다. |
| `/team panel [on\|off\|reset]` · `ctrl+shift+t` · `alt+t` | 팀 패널을 켜거나 끕니다. 패널이 떠 있어도 입력은 그대로 할 수 있습니다. `reset`은 패널을 원래 위치로 되돌립니다. |
| `/team send lead@<team> <내용>` | 팀장에게 메시지를 보냅니다. |
| `/team collect <team>` | 팀 요약을 메인 세션으로 가져옵니다. 모델은 실행하지 않습니다. |
| `/team close <team> [--confirm-unmerged]` | worktree를 정리합니다. 병합되지 않은 branch는 지우지 않습니다. |
| `/team preset show` · `/team alias show` | preset과 별칭을 보여 줍니다. |

## 설정 파일

- preset: `~/.pi/agent/teams/presets.json`, 또는 저장소별 `<repo>/.pi/teams/presets.json`
- 별칭: `~/.pi/agent/teams/aliases.json`, 또는 `<repo>/.pi/teams/aliases.json`

자세한 형식은 [`docs/DESIGN.md`](docs/DESIGN.md)를 참고하세요.

## 개발

```sh
npm install        # 타입 검사용 devDependencies(pi 1.6.0 패키지 사본, TypeScript)
npm run typecheck
```

pi가 제공하는 패키지(`@earendil-works/*`, `typebox`)는 `peerDependencies`로 선언합니다. `devDependencies`의 사본은 타입 검사와 LSP에만 쓰이며, pi는 실행할 때 자기 사본을 연결합니다.

## 라이선스

MIT
