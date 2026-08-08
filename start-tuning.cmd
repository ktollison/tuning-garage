@echo off
rem Tuning Garage launcher (Windows). Double-click to start.
setlocal
cd /d "%~dp0"

if "%PORT%"=="" set PORT=4590

echo Pulling latest from GitHub...
git pull --ff-only
if errorlevel 1 echo (pull failed - offline or local changes; the app will show sync status)

rem A server may already be running from an earlier window. Starting a second
rem one just fails to bind the port, and worse, a server left running across a
rem pull keeps serving the OLD code. Ask what is actually on the port.
rem   0 = running and current   1 = running but stale
rem   2 = nothing listening     3 = something else has the port
node scripts\version-check.mjs
if errorlevel 3 goto occupied
if errorlevel 2 goto start
if errorlevel 1 goto stale

echo Already running and up to date - opening http://127.0.0.1:%PORT%
start "" "http://127.0.0.1:%PORT%"
goto done

:stale
echo Restarting so the new code takes effect...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"TCP .*:%PORT% .*LISTENING"') do taskkill /f /pid %%p >nul 2>&1
rem give the port a moment to free up before rebinding
ping -n 3 127.0.0.1 >nul
goto start

:occupied
echo Port %PORT% is in use by something that is not this app.
echo Find it with:  netstat -ano ^| findstr :%PORT%
echo Or use another port:  set PORT=4700 ^&^& start-tuning.cmd
pause
goto done

:start
rem Wait for the server to accept a connection, then open the browser.
rem Notes on why it is written this way:
rem  - polls 127.0.0.1, NOT localhost: the server binds IPv4, while Windows
rem    resolves localhost to ::1 (IPv6) first, so a localhost poll never connects
rem  - raw TCP connect instead of Invoke-WebRequest: no proxy settings involved
rem  - no pipe characters: cmd would try to interpret them inside this string
rem  - opens the page even if the wait times out, so a slow start still lands
start "" /b powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){try{$c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',%PORT%); $c.Close(); break}catch{Start-Sleep -Seconds 1}}; Start-Process 'http://127.0.0.1:%PORT%'"

echo Starting Tuning Garage on http://127.0.0.1:%PORT% - close this window to stop it.
node app\server.mjs

pause

:done
endlocal
