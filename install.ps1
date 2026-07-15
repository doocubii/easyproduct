<#
  easyproduct 스킬 설치 스크립트 (Windows PowerShell)

  사용법:
    .\install.ps1                    → %USERPROFILE%\.claude\skills 에 설치 (전역, 기본값)
    .\install.ps1 -Base <기준 폴더>   → <기준 폴더>\.claude\skills 에 설치 (예: 프로젝트 폴더)

  - 대상 위치에 .claude\skills 폴더가 없으면 만들어 준다.
  - 이미 있는 스킬은 최신 내용으로 덮어쓴다(갱신).
  - 저장소 안의 skills\ 폴더를 원본으로 복사한다(이 스크립트는 저장소 루트에 있어야 한다).
#>
param(
  [string]$Base = $env:USERPROFILE
)

$ErrorActionPreference = "Stop"

# 이 스크립트가 있는 폴더(= 저장소 루트)를 기준으로 원본 skills\ 를 찾는다.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SrcDir = Join-Path $ScriptDir "skills"
$Dest = Join-Path (Join-Path $Base ".claude") "skills"

if (-not (Test-Path -LiteralPath $SrcDir)) {
  Write-Error "스킬 원본 폴더를 찾을 수 없습니다: $SrcDir  (저장소 루트에서 실행하세요.)"
  exit 1
}

# SKILL.md 메타 블록의 버전(백틱으로 감싼 X.Y.Z)을 읽는다(하드코딩 없음, 파일당 하나뿐).
# 한글에 의존하지 않는 ASCII 패턴이라 인코딩과 무관하게 동작한다.
function Read-SkillVersion([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $raw = Get-Content -LiteralPath $Path -Raw
  $m = [regex]::Match($raw, '`([0-9]+\.[0-9]+\.[0-9]+)`')
  if ($m.Success) { return $m.Groups[1].Value }
  return $null
}

# 버전 기준 스킬은 easyproduct-suite(항상 존재).
$CurVer = Read-SkillVersion (Join-Path $SrcDir "easyproduct-suite\SKILL.md")
$OldVer = Read-SkillVersion (Join-Path $Dest "easyproduct-suite\SKILL.md")   # 덮어쓰기 전에 읽는다.

Write-Host "설치 원본 : $SrcDir"
Write-Host "설치 위치 : $Dest"
Write-Host "설치할 버전   : $(if ($CurVer) { $CurVer } else { '알 수 없음' })"
if ($OldVer) {
  Write-Host "기존 설치 버전 : $OldVer"
  if ($OldVer -eq $CurVer) {
    Write-Host "                (같은 버전 재설치)"
  } else {
    Write-Host "                ($OldVer -> $(if ($CurVer) { $CurVer } else { '?' }) 로 갱신)"
  }
} else {
  Write-Host "기존 설치 버전 : 없음 (신규 설치)"
}

# .claude\skills 가 없으면 만든다.
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

$count = 0
Get-ChildItem -LiteralPath $SrcDir -Directory | ForEach-Object {
  # SKILL.md 가 있는 폴더만 스킬로 취급한다.
  if (-not (Test-Path -LiteralPath (Join-Path $_.FullName "SKILL.md"))) { return }

  $target = Join-Path $Dest $_.Name
  if (Test-Path -LiteralPath $target) {
    Remove-Item -Recurse -Force -LiteralPath $target
    $action = "갱신"
  } else {
    $action = "설치"
  }
  Copy-Item -Recurse -Force -LiteralPath $_.FullName -Destination $target
  Write-Host "  [$action] $($_.Name)"
  $count++
}

if ($count -eq 0) {
  Write-Error "설치할 스킬을 찾지 못했습니다($SrcDir 안에 SKILL.md가 있는 폴더가 없음)."
  exit 1
}

Write-Host "완료: $count개 스킬을 $Dest 에 설치했습니다."
Write-Host "새 Claude Code 세션을 시작하면 스킬이 인식됩니다."
