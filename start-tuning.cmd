@echo off
rem Tuning Garage launcher (Windows). Double-click to start.
rem Pulls the latest, then starts the app - or restarts it if an older version
rem is still running - and opens it in your browser.
setlocal
title Tuning Garage
cd /d "%~dp0"

if "%PORT%"=="" set PORT=4590

rem Check the tools first. A missing node returns 9009, which every errorlevel
rem test below would otherwise read as "the port is in use by something else".
where git >nul 2>nul
if errorlevel 1 goto nogit
where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)"
if errorlevel 1 goto oldnode

echo Pulling latest from GitHub...
git pull --ff-only
if errorlevel 1 echo (pull failed - offline or local changes; the app will show sync status)

rem What is on the port decides what to do:
rem   0 = this app, current   1 = this app, older than the code on disk
rem   2 = nothing listening   3 = something else   4 = this checkout is broken
node scripts\version-check.mjs
if errorlevel 4 goto broken
if errorlevel 3 goto occupied
if errorlevel 2 goto start
if errorlevel 1 goto stale

echo Already running and up to date - opening http://127.0.0.1:%PORT%
start "" "http://127.0.0.1:%PORT%"
goto done

:stale
echo Restarting so the new code takes effect...
rem Ask the OS which process owns the port: findstr cannot match netstat output
rem reliably. Kept free of pipe characters so cmd never tries to parse them.
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; foreach ($x in $c) { Stop-Process -Id $x.OwningProcess -Force -ErrorAction SilentlyContinue }"
rem give the port a moment to free up before rebinding
ping -n 3 127.0.0.1 >nul
goto start

:start
rem Open the browser once the server accepts connections - polled on
rem 127.0.0.1, not localhost (Windows tries IPv6 first; the server is IPv4) -
rem and open it anyway after 40 s so a slow start still lands.
start "" /b powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){try{$c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',%PORT%); $c.Close(); break}catch{Start-Sleep -Seconds 1}}; Start-Process 'http://127.0.0.1:%PORT%'"

echo Starting Tuning Garage on http://127.0.0.1:%PORT% - close this window to stop it.
node app\server.mjs
rem only reached if the server stops: keep its last message on screen
pause
goto done

:occupied
echo Port %PORT% is in use by something that is not this app.
echo Find it with:  netstat -ano ^| findstr :%PORT%
echo To use another port, type these two lines in a Command Prompt here:
echo   set PORT=4700
echo   start-tuning.cmd
pause
goto done

:broken
echo app\server.mjs is missing or has no version - this folder is not a complete
echo Tuning Garage checkout. Check git status, or clone your repository again.
pause
goto done

:nogit
echo Git was not found. Install Git for Windows - see SETUP-WINDOWS.md, step 1 -
echo and choose "Git from the command line and also from 3rd-party software".
pause
goto done

:nonode
echo Node.js was not found. Install the LTS version from https://nodejs.org -
echo see SETUP-WINDOWS.md, step 1 - then open a new window and try again.
pause
goto done

:oldnode
for /f %%v in ('node --version') do echo Node.js 18 or newer is needed - this machine has %%v.
echo Install the LTS version from https://nodejs.org, then try again.
pause
goto done

:done
endlocal
