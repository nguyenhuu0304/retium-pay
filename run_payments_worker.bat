@echo off
cd /d "%~dp0"
if not exist ".env.local" (
  echo ERROR: .env.local not found in this project.
  pause
  exit /b 1
)
node --env-file=.env.local scripts\payments-worker.mjs
pause
