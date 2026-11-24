# 인계: rogallyx에서 pi-team 관리 (2026-11-25)

## 소유와 위치

- 저장소: `https://github.com/zerodice0/pi-team`(공개, MIT)이며 기준 branch는 `main`입니다.
- 관리 주체: **rogallyx**의 `~/workspace/development/pi-team` 체크아웃과 그 Herdr workspace에서 실행하는 pi 세션입니다. 이 세션이 저장소의 단일 조율자이며, 이슈·branch·병합·push를 맡습니다.
- 다른 호스트는 사용자 입장에서만 씁니다. Mac Studio에도 `~/workspace/development/pi-team`이 있고 `pi install`로 연결되어 있지만, 그 체크아웃은 `git pull`만 합니다. Mac Studio에서 직접 수정하지 않습니다.

## 지금까지 된 것

모두 Mac Studio의 pi 1.6.0, pi-subagents 0.90.0 환경에서 검증했습니다.

- 설계 v3(`docs/DESIGN.md`) 구현을 마쳤고, 수용 기준 A1~A8과 별칭 B1~B4를 실제 모델로 검증했습니다.
- 커밋 내역:
  - `6a5040d`: 구현
  - `944c5fa`: 설계 문서
  - `ffaacc3`: 별칭
- Herdr pi 통합(`herdr integration install pi`, v9)을 Mac Studio, macbook-pro, winmini, rogallyx에 설치했습니다.

## 남은 작업 (우선순위 순)

1. **rogallyx 환경 준비**
   - pi 로그인: 사용자가 `/login`으로 anthropic과 openai-codex OAuth를 직접 해야 합니다. 다른 호스트의 `auth.json`은 복사하지 않습니다. refresh token이 회전하면서 서로 무효화되기 때문입니다.
   - `pi install npm:pi-subagents`와 `pi install ~/workspace/development/pi-team`을 실행합니다.
   - image 역할을 쓸 경우에만 `npm i --prefix ~/.pi/agent/teams/vendor pi-codex-image-gen@0.3.2`를 실행합니다.
2. **Linux 회귀 검증**
   - A1~A8과 B1~B4를 rogallyx(CachyOS, fish, Herdr 0.9.5)에서 다시 확인합니다. 시험용 저렴한 preset을 쓰고, 일회용 저장소에서 실행합니다.
   - 특히 확인할 것:
     - `fs.watch` 수신
     - Herdr `worktree create` 출력 파싱
     - worktree 경로 규칙
     - Herdr에서 실행한 팀장 pane의 agent 상태 표시(pi 통합)
3. **미검증 fallback 경로**
   - 지금까지는 cooldown을 인위적으로 주입해서만 검증했습니다. 실제 공급자의 quota, overload, auth 오류에서 동작은 확인하지 않았습니다.
   - 실제 오류 메시지 표본으로 `classify()`를 보강하고 회귀 테스트를 추가합니다.
4. **잠금 파일 회수**
   - 레지스트리에 쓰는 도중 강제 종료되면 `~/.pi/agent/teams/.*.lock`이 남습니다.
   - 소유 PID가 이미 죽은 잠금을 안전하게 회수하는 기능을 구현합니다.
5. **배포 호스트 확대**
   - winmax2와 desktop-1이 다시 온라인이 되면 pi와 Herdr pi 통합을 설치합니다. 각 호스트의 로그인은 사용자가 합니다.

## 지켜야 할 계약

- 메인 세션의 모델, thinking, 도구는 바꾸지 않습니다. 메인 모델용 도구는 `team_enable`을 거친 뒤에만 활성화합니다.
- 메시지에는 `fyi`/`action` 종류가 없고 `replyTo` 스레드만 있습니다. 팀원은 자기 팀 안에서만 보내고, 다른 팀과는 팀장끼리만 주고받습니다.
- 팀 branch는 자동으로 병합하지 않습니다. 병합되지 않은 branch는 삭제하지 않습니다.
- 시험 산출물과 작업 파일은 `/tmp`에 두지 않습니다. 시험용으로 띄운 pi, Herdr workspace, worktree는 직접 정리합니다.
