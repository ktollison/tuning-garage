@echo off
rem Tuning Garage launcher (Windows). Double-click to start.
cd /d "%~dp0"

echo Pulling latest from GitHub...
git pull --ff-only
if errorlevel 1 echo (pull failed - offline or local changes; the app will show sync status)

rem Wait for the server to accept a connection, then open the browser.
rem Notes on why it is written this way:
rem  - polls 127.0.0.1, NOT localhost: the server binds IPv4, while Windows
rem    resolves localhost to ::1 (IPv6) first, so a localhost poll never connects
rem  - raw TCP connect instead of Invoke-WebRequest: no proxy settings involved
rem  - no pipe characters: cmd would try to interpret them inside this string
rem  - opens the page even if the wait times out, so a slow start still lands
start "" /b powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){try{$c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',4590); $c.Close(); break}catch{Start-Sleep -Seconds 1}}; Start-Process 'http://127.0.0.1:4590'"

echo Starting Tuning Garage on http://127.0.0.1:4590 - close this window to stop it.
node app\server.mjs

pause
