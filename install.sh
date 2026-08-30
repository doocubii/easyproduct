#!/usr/bin/env bash
# easyproduct 스킬 설치 스크립트 (macOS / Linux / Git Bash)
#
# 사용법:
#   ./install.sh          대화형: "전역(~/.claude)에 설치할까요? [Y/n]"
#                         → Y/엔터 = 전역(~/.claude/skills)
#                         → n      = 프로젝트 폴더 경로를 입력받아 <폴더>/.claude/skills 에 설치
#   ./install.sh -y       컨펌 없이 전역(~/.claude/skills)에 설치
#   ./install.sh <기준 폴더>   컨펌 없이 <기준 폴더>/.claude/skills 에 설치 (예: 프로젝트 폴더, '.' = 현재 폴더)
#
# - 대상 위치에 .claude/skills 폴더가 없으면 만들어 준다.
# - 이미 있는 스킬은 최신 내용으로 덮어쓴다(갱신).
# - 저장소 안의 skills/ 폴더를 원본으로 복사한다(이 스크립트는 저장소 루트에 있어야 한다).

set -euo pipefail

# 이 스크립트가 있는 폴더(= 저장소 루트)를 기준으로 원본 skills/ 를 찾는다.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/skills"

# 인자 파싱: -y(컨펌 생략·전역), 위치 인자(기준 폴더).
ASSUME_YES=0
BASE_ARG=""
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help)
      cat <<'USAGE'
사용법:
  ./install.sh          대화형 컨펌 후 설치 (Y=전역 ~/.claude, n=프로젝트 폴더 입력)
  ./install.sh -y       컨펌 없이 전역(~/.claude/skills)에 설치
  ./install.sh <폴더>   컨펌 없이 <폴더>/.claude/skills 에 설치 ('.' = 현재 폴더)
USAGE
      exit 0 ;;
    -*) echo "알 수 없는 옵션: $arg (사용법: ./install.sh -h)" >&2; exit 2 ;;
    *) BASE_ARG="$arg" ;;
  esac
done

# 기준 폴더 결정
if [ -n "$BASE_ARG" ]; then
  BASE="$BASE_ARG"                          # 명시 경로 → 그대로(비대화)
elif [ "$ASSUME_YES" -eq 1 ]; then
  BASE="$HOME"                              # -y → 전역, 컨펌 없이
elif [ -t 0 ]; then
  # 대화형 컨펌
  printf "전역(~/.claude)에 설치할까요? [Y/n] "
  read -r _ans
  case "$_ans" in
    [nN]*)
      printf "설치할 프로젝트 폴더 경로를 입력하세요(예: . 또는 /path/to/project): "
      read -r _proj
      [ -n "$_proj" ] || { echo "폴더 경로가 비었습니다. 취소합니다." >&2; exit 1; }
      _proj="${_proj/#\~/$HOME}"            # 앞의 ~ 를 홈으로 확장
      BASE="$_proj"
      ;;
    *) BASE="$HOME" ;;                      # Y/엔터(기본) → 전역
  esac
else
  # 비대화 입력(파이프 등): 프롬프트 불가 → 전역 기본 + 안내
  echo "비대화 입력이라 컨펌을 건너뜁니다 → 전역(~/.claude)에 설치합니다." >&2
  echo "(프로젝트에 설치하려면 './install.sh <폴더>', 전역을 명시하려면 '-y')" >&2
  BASE="$HOME"
fi
DEST="$BASE/.claude/skills"

if [ ! -d "$SRC_DIR" ]; then
  echo "오류: 스킬 원본 폴더를 찾을 수 없습니다: $SRC_DIR" >&2
  echo "이 스크립트는 저장소 루트(skills/ 폴더 옆)에서 실행해야 합니다." >&2
  exit 1
fi

# SKILL.md 메타 블록의 버전을 읽는다 — **줄 끝에 홀로 놓인** 백틱 버전만 본다.
#
# **"파일에서 첫 X.Y.Z를 찾는다"로 하지 않는다(중요).** 예전엔 그렇게 했는데, 본문이 다른 버전을
# 인용하는 순간 **그게 먼저 잡혔다** — `벤더 VERSION이 0.11.0에 멈춰 있어` 라는 설명문 때문에
# **0.12.8을 깔면서 0.11.0이라고 보고**했다. 파일은 최신인데 **표시만 틀리는** 꼴이라, 사용자는
# "설치가 안 됐다"고 읽고 원인을 엉뚱한 데서 찾는다(실제로 그랬다).
# 메타 줄은 줄 끝에서 닫히고 산문 인용은 뒤에 조사·글자가 붙으므로, 그 차이로 둘을 가른다.
# 한글에 기대지 않아 인코딩과도 무관하다.
read_version() {
  [ -f "$1" ] || { echo ""; return; }
  grep -oE '`[0-9]+\.[0-9]+\.[0-9]+`[[:space:]]*$' "$1" | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'
}

# 버전 기준 스킬은 easyproduct-suite(항상 존재).
CUR_VER="$(read_version "$SRC_DIR/easyproduct-suite/SKILL.md")"
OLD_VER="$(read_version "$DEST/easyproduct-suite/SKILL.md")"   # 덮어쓰기 전에 읽는다.

echo "설치 원본 : $SRC_DIR"
echo "설치 위치 : $DEST"
echo "설치할 버전   : ${CUR_VER:-알 수 없음}"
if [ -n "$OLD_VER" ]; then
  echo "기존 설치 버전 : $OLD_VER"
  if [ "$OLD_VER" = "$CUR_VER" ]; then
    echo "                (같은 버전 재설치)"
  else
    echo "                ($OLD_VER → ${CUR_VER:-?} 로 갱신)"
  fi
else
  echo "기존 설치 버전 : 없음 (신규 설치)"
fi

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
