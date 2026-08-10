# 모노레포 — 저장소 루트 ≠ spec-kit 루트일 때

> 검사기의 기준점 `ROOT`는 **`git rev-parse --show-toplevel`(저장소 루트)**다. 그런데 모노레포에서는
> spec-kit이 **트랙 하위 폴더**(`frontend-user/`·`services/api/` 같은)에 있다. 이 어긋남이 조사(Step 0)에서
> 안 잡히면 설치가 조용히 반쯤 망가진다 — 아래 5가지가 실제로 밟은 함정이다.

## 판별

**Step 0-9**에서 본다: `.specify/`가 저장소 루트에 있나, 하위 폴더에 있나. 하위면 이 문서를 따른다.
트랙이 여러 개면(`frontend-user`·`frontend-backoffice`…) **트랙마다 정책 파일이 하나씩** 필요하다
(검사기는 한 번에 한 정책·한 `specsDir`만 본다).

## 함정 5개와 처치

| # | 증상 | 처치 |
|---|---|---|
| 1 | **글롭이 하나도 안 맞는다** — `app/**/*.ts`로 썼는데 실제 경로는 `frontend-user/app/…` | 정책의 **모든 경로에 트랙 접두를 붙인다**: `governedGlobs`·`allowlist`·`specsDir`·`upstreamDocs.globs`·`pins.globalPinFile`·`reviewRecord.path`. 경로는 전부 **저장소 루트 기준**이다 |
| 2 | **정책을 못 찾는다** | 검사기는 **cwd 기준 → 저장소 루트 기준** 순으로 찾는다. 트랙 안에서 실행하면(`cd frontend-user && … --full`) 트랙의 `sdd-policy.json`을 자동으로 찾는다. `--policy`에 준 상대경로도 cwd 기준을 먼저 본다 |
| 3 | **형제 트랙까지 경고가 뜬다** — `unmatchedNewFiles`가 저장소 전체의 신규 소스를 훑는다 | 남의 트랙 코드는 내 관장 대상이 아니다. `unmatchedNewFiles: "off"`로 두거나, **`allowlist`에 형제 트랙을 통째로 넣는다**(`frontend-backoffice/**`·`services/**`). 후자를 권장 — "왜 제외했는지"가 정책에 남는다 |
| 4 | **남의 트랙 문서를 고쳤는데 내 슬라이스가 위반이 된다** — ⑥ 역결합이 `upstreamDocs.globs`에 걸린 모든 변경을 본다 | `upstreamDocs.globs`를 **내 트랙이 실제로 근거로 삼는 문서만** 남기게 좁힌다(공유 SSOT + 내 트랙 헌법·CLAUDE.md). 공유 문서를 여러 트랙이 같이 본다면 그건 정상이다 — 트랙마다 각자 흡수해야 하는 변경이 맞다 |
| 5 | **`mainBranch` 기본 `main`이 안 맞는다** | 모노레포는 트랙별 브랜치(`frontend-user-main`·`…-beta`)를 쓰는 일이 많다. **CI가 게이트하는 머지 타깃 브랜치**를 넣는다(③⑥의 base가 "이 MR이 무엇을 바꾸나"와 일치해야 한다) |

## 정책 예시 (트랙이 `frontend-user/`, 공유 문서가 `app_docs/`)

```jsonc
{
  "specsDir": "frontend-user/specs",
  "governedGlobs": ["frontend-user/app/**/*.ts", "frontend-user/app/**/*.tsx"],
  "allowlist": [
    "frontend-user/app/root.tsx", "frontend-user/app/routes.ts",
    "frontend-user/app/**/+types/**",
    "frontend-backoffice/**", "services/**"          // 형제 트랙 — 내 관장 대상 아님(함정 3)
  ],
  "unmatchedNewFiles": "warn",
  "upstreamDocs": {
    "globs": [                                        // 내 트랙이 근거로 삼는 것만(함정 4)
      "app_docs/**/*.md",
      "frontend-user/.specify/memory/constitution.md",
      "frontend-user/CLAUDE.md"
    ],
    "docsAdapter": "easyproduct"
  },
  "pins": { "globalPinFile": "frontend-user/.specify/sdd-sources.json" },
  "reviewRecord": { "path": "frontend-user/specs/<slug>/upstream-check.md" },
  "mainBranch": "frontend-user-beta"                  // CI 머지 타깃(함정 5)
}
```

## 배선할 때

- **실행 위치를 하나로 고정한다.** 트랙 안에서 도는 `verify`·훅이라면 `cd <트랙>`이 이미 돼 있으니
  `--policy` 없이 그냥 부르면 된다(함정 2). CI에서 저장소 루트부터 시작한다면 트랙으로 `cd` 한 줄을 먼저 둔다.
- **훅 스크립트의 상대경로 깊이에 주의한다.** 검사기를 `harness/sdd/`처럼 하위 폴더로 모으면
  `dirname "$0"` 기반 `cd ../..` 깊이가 바뀐다. 옮긴 뒤 반드시 한 번 실행해 확인한다.
- **트랙이 여럿이면 잡도 여럿이다.** 트랙마다 정책·호출을 따로 두고, 리포트도 트랙별로 낸다.
  하나의 검사기 호출로 두 트랙을 동시에 보려 하지 않는다(`specsDir`이 하나라 슬라이스가 섞인다).
