@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   KUKUK - instalacia
echo   ==================
echo.

where node >nul 2>nul
if errorlevel 1 goto :nonode

echo [1/4] Pripajam Kukuk do Claude Code...
node kukuk.js install
if errorlevel 1 goto :err

echo.
echo [2/4] Spustam Kukuk na pozadi - zapne sa aj po restarte PC...
node kukuk.js autostart
if errorlevel 1 goto :err
timeout /t 2 /nobreak >nul

echo.
echo [3/4] Spristupnujem Kukuk pre telefon cez Tailscale...
where tailscale >nul 2>nul
if errorlevel 1 goto :notailscale
tailscale serve --bg 8787
goto :pair

:notailscale
echo   Tailscale nie je nainstalovany.
echo   Stiahni ho z https://tailscale.com/download - na PC aj do telefonu -
echo   prihlas sa rovnakym uctom a spusti tento subor znova.
start https://tailscale.com/download

:pair
echo.
echo [4/4] Parovaci kod pre telefon:
node kukuk.js pair
echo   Na telefone otvor v Chrome adresu https://....ts.net vypisanu vyssie a zadaj kod.
echo   Potom restartuj Claude Code.
echo.
pause
exit /b 0

:nonode
echo   Chyba Node.js. Stiahni verziu LTS z https://nodejs.org, nainstaluj ju
echo   a potom spusti tento subor znova.
start https://nodejs.org
pause
exit /b 1

:err
echo.
echo   Nieco sa pokazilo - posli mi text vyssie.
pause
exit /b 1
