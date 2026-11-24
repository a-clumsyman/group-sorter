@echo off
rem Double-click this file to start Group Sorter on Windows.
setlocal
title Group Sorter
cd /d "%~dp0"

if not exist "src\index.js" (
  echo.
  echo  This file must stay inside the Group Sorter folder.
  echo  If you opened it from inside the zip file: close this window, right-click
  echo  the zip file, choose "Extract All", then open the new folder and try again.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  One thing to install first: Node.js, which is free.
  echo  A download page is opening. Install the version marked LTS,
  echo  then double-click this file again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

if not exist "node_modules\.ready" (
  echo.
  echo  First-time setup. Downloading what the bot needs. This takes a minute or two...
  echo.
  call npm ci --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  Setup could not finish. Check the internet connection and double-click this file again.
    echo.
    pause
    exit /b 1
  )
  echo ready> "node_modules\.ready"
)

:run
node "src\index.js"
if %errorlevel%==0 goto end
if %errorlevel%==2 goto stay
echo.
echo  The bot stopped unexpectedly. Starting it again in 5 seconds.
echo  Close this window if you want it to stay stopped.
timeout /t 5 /nobreak >nul
goto run

:stay
echo.
pause

:end
endlocal
