#!/usr/bin/env bash
# easyproduct 스킬 설치 스크립트 (macOS / Linux / Git Bash)
#
# 사용법:
#   ./install.sh                 → ~/.claude/skills 에 설치 (전역, 기본값)
#   ./install.sh <기준 폴더>      → <기준 폴더>/.claude/skills 에 설치 (예: 프로젝트 폴더)
#
# - 대상 위치에 .claude/skills 폴더가 없으면 만들어 준다.
# - 이미 있는 스킬은 최신 내용으로 덮어쓴다(갱신).
# - 저장소 안의 skills/ 폴더를 원본으로 복사한다(이 스크립트는 저장소 루트에 있어야 한다).

set -euo pipefail

# 이 스크립트가 있는 폴더(= 저장소 루트)를 기준으로 원본 skills/ 를 찾는다.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/skills"

# 첫 번째 인자가 있으면 그 폴더를 기준으로, 없으면 홈 디렉터리(~)를 기준으로.
BASE="${1:-$HOME}"
DEST="$BASE/.claude/skills"

if [ ! -d "$SRC_DIR" ]; then
  echo "오류: 스킬 원본 폴더를 찾을 수 없습니다: $SRC_DIR" >&2
  echo "이 스크립트는 저장소 루트(skills/ 폴더 옆)에서 실행해야 합니다." >&2
  exit 1
fi

echo "설치 원본 : $SRC_DIR"
echo "설치 위치 : $DEST"

# .claude/skills 가 없으면 만든다.
mkdir -p "$DEST"

count=0
for skill in "$SRC_DIR"/*/; do
  name="$(basename "$skill")"
  # SKILL.md 가 있는 폴더만 스킬로 취급한다.
  [ -f "${skill}SKILL.md" ] || continue

  target="$DEST/$name"
  if [ -e "$target" ]; then
    rm -rf "$target"
    action="갱신"
  else
    action="설치"
  fi
  cp -R "${skill%/}" "$DEST/"
  echo "  [$action] $name"
  count=$((count + 1))
done

if [ "$count" -eq 0 ]; then
  echo "설치할 스킬을 찾지 못했습니다($SRC_DIR 안에 SKILL.md가 있는 폴더가 없음)." >&2
  exit 1
fi

echo "완료: $count개 스킬을 $DEST 에 설치했습니다."
echo "새 Claude Code 세션을 시작하면 스킬이 인식됩니다."
