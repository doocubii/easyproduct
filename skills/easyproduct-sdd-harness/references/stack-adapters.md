# 스택 어댑터 — 조사(Step 0-2) 결과로 고르는 기본값

> 여기 값은 **초안 제안용 기본값**이다. 그대로 쓰지 말고 조사 결과를 붙여 사용자에게 제안하고 확인받는다.
> 확정된 값은 전부 `sdd-policy.json`에 들어가며, 검사기 로직에는 아무것도 박지 않는다.

## 감지 방법

| 신호 | 읽는 것 |
|---|---|
| 언어 | `package.json` · `pyproject.toml`/`setup.cfg`/`requirements.txt` · `go.mod` · `Cargo.toml` · `pom.xml`/`build.gradle` |
| **프레임워크** | **매니페스트의 의존성 목록**을 실제로 훑는다: react-router·next·express·nest(JS) / fastapi·django·flask(Py) / gin·echo·chi(Go) / axum·actix(Rust) |
| 통합 지점 | `package.json` scripts(`verify`·`lint`·`test`) · `Makefile` · `.pre-commit-config.yaml` · `.github/workflows/*` · `.gitlab-ci.yml` · `.claude/settings.json` |
| 주 브랜치 | `git symbolic-ref refs/remotes/origin/HEAD` → 실패 시 현재 기본 브랜치 추정 후 **확인받는다** |

## 스택별 기본값

### JS/TS

```jsonc
{
  "governedGlobs": ["src/**/*.{ts,tsx,js,jsx}", "app/**/*.{ts,tsx}"],
  "allowlist": ["**/*.d.ts", "**/*.config.*", "src/main.*", "app/root.*", "app/entry.*",
                "**/__generated__/**", "**/*.gen.*"],
  "commentSyntaxes": ["//", "/*"],
  "integration": { "verify": "package.json scripts.verify", "ci": ".github/workflows" }
}
```
프레임워크 보정: **Next.js** → `app/**`·`pages/**`에서 `layout.*`·`loading.*`·`error.*`는 스캐폴딩이라 allowlist 후보.
**React Router** → `app/routes/**`가 관장 핵심, `app/routes.ts`는 allowlist.

### Python

```jsonc
{
  "governedGlobs": ["src/**/*.py", "<pkg>/**/*.py"],
  "allowlist": ["**/__init__.py", "**/conftest.py", "**/settings.py", "**/migrations/**",
                "**/alembic/versions/**"],
  "commentSyntaxes": ["#"],
  "integration": { "verify": "pytest 또는 Makefile", "hook": ".pre-commit-config.yaml", "ci": ".github/workflows" }
}
```
프레임워크 보정: **Django** → `models.py`·`views.py`·`serializers.py`가 관장 핵심, `admin.py`·`apps.py`는 판단 후.
**FastAPI** → `routers/**`·`services/**`·`schemas/**`.

### Go

```jsonc
{
  "governedGlobs": ["internal/**/*.go", "cmd/**/*.go", "pkg/**/*.go"],
  "allowlist": ["**/*_test.go", "**/mock_*.go", "**/zz_generated*.go"],
  "commentSyntaxes": ["//"],
  "integration": { "verify": "Makefile 또는 go vet 래핑", "ci": ".github/workflows" }
}
```

### Rust

```jsonc
{
  "governedGlobs": ["src/**/*.rs", "crates/*/src/**/*.rs"],
  "allowlist": ["src/main.rs", "**/build.rs", "**/tests/**"],
  "commentSyntaxes": ["//", "/*"],
  "integration": { "verify": "cargo make / Makefile", "ci": ".github/workflows" }
}
```

### JVM (Java/Kotlin)

```jsonc
{
  "governedGlobs": ["src/main/java/**/*.java", "src/main/kotlin/**/*.kt"],
  "allowlist": ["**/*Application.{java,kt}", "**/generated/**", "**/build/**"],
  "commentSyntaxes": ["//", "/*"],
  "integration": { "verify": "gradle check / maven verify", "ci": ".github/workflows" }
}
```

## allowlist를 정하는 원칙

**"이 파일이 spec에서 파생될 수 있는 종류인가"**로 판단한다.

- **넣는다**: 프레임워크 스캐폴딩·엔트리포인트·설정·자동생성·마이그레이션·테스트 픽스처.
- **넣지 않는다**: 도메인 로직·라우트 핸들러·화면 컴포넌트·서비스·모델 — **여기가 관장의 이유**다.
- allowlist가 커지면 게이트가 무의미해진다. **조사(Step 0-7)에서 관장 사각 수를 세어** 사용자에게 보여주고,
  넓은 allowlist는 사유를 남기게 한다.

## 태그를 파일 어디에 두나

파일 **앞부분(첫 주석 블록, 대략 20줄 이내)**만 스캔한다 — 전체 스캔은 느리고 오탐(문자열 안의 태그)을 만든다.

```ts
// @sdd 001-operator-console
```
```py
# @sdd 001-operator-console
```
```rust
//! @sdd 001-operator-console
```

셔뱅·라이선스 헤더·`"use client"` 지시자가 앞에 오는 경우가 있으므로 **첫 줄 고정이 아니라 앞부분 범위**로 본다.
