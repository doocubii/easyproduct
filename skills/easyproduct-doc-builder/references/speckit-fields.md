# spec-kit 누락 점검용 체크리스트

**중요:** 최종 산출물은 이 형식이 **아니다.** 최종 산출물은 `assets/기획서-템플릿.md`,
`assets/설계서-템플릿.md` 기반의 **읽기 쉬운 문서**다. 이 파일은 그 문서가 나중에
spec-kit이 `spec.md` / `plan.md`로 잘 추출할 수 있을 만큼 **내용이 빠지지 않았는지**
마지막에 점검하는 용도다. 사용자가 **자료를 가져온 경우엔 흡수 단계(Step 1)에서** 이 목록으로
이미 채워진 항목과 빈 항목을 가르는 데도 쓴다.

같은 폴더의 `spec-template.md`, `plan-template.md`는 spec-kit이 실제로 채우는 원본
구조다(참고용). 사용자에게 이 표기(FR-001, Given/When/Then, SC-001, 영문 헤더)를
**그대로 보여주지 않는다.**

## 기획서가 spec-kit `spec.md`에 대응하는지 점검

기획서를 마무리하기 전, 아래 내용이 **읽기 쉬운 문장 형태로** 들어 있는지 확인한다.

- [ ] 무엇을·누구를 위해 만드는지 (→ spec의 정체성/Input)
- [ ] 중요한 순서가 매겨진 사용자 행동 여러 개 (→ User Stories, 우선순위)
- [ ] 가장 중요한 행동만으로도 쓸 만한지 = MVP 경계 (→ Independent Test)
- [ ] 상황별로 "이러면 이렇게 된다"는 동작 설명 (→ Acceptance Scenarios)
- [ ] 예외·돌발 상황 (→ Edge Cases)
- [ ] 꼭 있어야 하는 기능들이 **자세히** (무엇을·누가·입력→결과·규칙·금지) (→ Functional Requirements)
- [ ] 있으면 좋은 기능은 따로 구분 (→ 우선순위/범위)
- [ ] 정보 덩어리가 **그룹명(영문 소문자·단수) · 한글명 · 설명**으로 정의됨 (필드 수준 아님, **그룹 수준**만) (→ Key Entities). 개별 필드는 데이터 모델·화면 설계 단계 몫.
- [ ] 결과·체감으로 표현한 성공 기준 (→ Success Criteria, 측정 가능)
- [ ] 임의로 정한 부분을 적어둔 가정 (→ Assumptions)

## 설계서가 spec-kit `plan.md`에 대응하는지 점검

- [ ] 종류와 사용 환경: 웹/앱/프로그램 (→ Project Type, Target Platform)
- [ ] 예상 규모 (→ Scale/Scope)
- [ ] 속도·오프라인 등 조건 (→ Performance Goals, Constraints)
- [ ] 사용할 기술과 그 이유 (→ Language, Dependencies, Storage, Testing)
- [ ] 큰 그림 구성 (→ Project Structure 방향)
- [ ] 아직 못 정한 것 표시 (→ NEEDS CLARIFICATION)

빠진 항목이 있으면 사용자에게 한 가지씩만 더 물어 채운다. 그래도 정할 수 없으면
기획서의 "가정" 또는 설계서의 "아직 안 정한 것"에 적어둔다.
