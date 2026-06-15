@echo off
chcp 65001 >nul
echo 청약/분양 통합 뷰어 서버를 시작합니다...
where python >nul 2>nul
if errorlevel 1 (
  echo [오류] Python을 찾을 수 없습니다. https://www.python.org 에서 설치 후 다시 실행하세요.
  pause
  exit /b 1
)
start "" http://localhost:8000
python "%~dp0server.py"
pause
