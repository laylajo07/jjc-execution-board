@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 기존 8787 포트 프로그램 종료
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }" >nul 2>nul

rem 러너 실행 (제출 대상 B_직접/앱을 앱 폴더로 지정 -> 회의록·AGENT.md 경로가 이 폴더 기준으로 정확히 잡힘)
where python >nul 2>nul
if not errorlevel 1 (
    start "Runner" cmd /k python "%~dp0러너\py\server.py" "%~dp0B_직접\앱"
) else (
    start "Runner" cmd /k py "%~dp0러너\py\server.py" "%~dp0B_직접\앱"
)

timeout /t 3 /nobreak >nul

rem 웹페이지 실행
start "" "http://localhost:8787/index.html"
