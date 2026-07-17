# tools

easyproduct 문서 세트를 점검하는 참조 구현.

## check-docs.mjs

문서 세트의 frontmatter·기계 블록·크로스도큐먼트 참조를 점검하는 **무의존 Node.js 점검기**(npm 설치 불필요).

```
node tools/check-docs.mjs <문서세트-루트>
```

- 문서 발견: `<루트>/00-index.md`의 `docbundle.docs` 매니페스트 → 없으면 `*.md` 스캔.
- 검증: 각 문서의 기계 블록을 `machine.schema`가 가리키는 JSON Schema로 확인.
- 참조 무결성: 접두사 라우팅(`FEAT./DATA./POL./UI./SCN.`)으로 죽은 링크 탐지.
- 종료코드: 문제 있으면 `1`, 통과면 `0`. (CI 게이트로 사용 가능.)

규약·필드 의미·anchor 레지스트리·라우팅 규칙은 **`skills/easyproduct-suite/references/checker-guide.md`**에 있다. 이 점검기는 그 가이드의 참조 구현이다.

> JSON Schema 부분집합(type·required·enum·const·pattern·minItems·minProperties·properties·items·additionalProperties)만 구현한다. 완전 준수가 필요하면 `ajv`로 교체하되 스키마 파일은 그대로 쓴다.
