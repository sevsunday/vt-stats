@echo off
title BZCC Statsgate Launch Helper

:: =======================================================================
:: INSTRUCTIONS FOR STEAM:
:: To use this script, right-click Battlezone Combat Commander in Steam, 
:: go to Properties -> General -> Launch Options, and paste this exact 
:: line (including quotes), replacing the path with your actual folder:
::
:: "C:\Your\Full\Path\To\launch.bat" %command%
::
:: NOTE: this script should live in the same directory as the Statsgate EXE and DLL!
::
:: =======================================================================

echo ===================================================
echo             BZCC Statsgate Launch Helper
echo ===================================================
echo.

:: PRE-FLIGHT CHECKS
:: 1. Check if the user double-clicked the script instead of using Steam Launch Options
if "%~1"=="" (
    echo [ERROR] No game path provided. 
    echo         Did you double-click this file by mistake? 
    echo         This script must be run via Steam Launch Options using %%command%%
    goto ErrorExit
)

:: 2. Check if the stats launcher actually exists in this folder
if not exist "%~dp0statslauncher.exe" (
    echo [ERROR] statslauncher.exe is missing!
    echo         Please ensure this batch file is in the exact same folder as the launcher.
    goto ErrorExit
)

:: STEP 1: REMOVE MARK OF THE WEB
echo [1/3] Verifying files and clearing Windows MotW blocks...
powershell -NoProfile -Command "Get-ChildItem -Path '%~dp0' -Recurse | Unblock-File"
if %ERRORLEVEL% NEQ 0 (
    echo [WARNING] PowerShell encountered an issue clearing file blocks.
    echo           The launcher or DLL may still be blocked by Windows Defender.
)

:: STEP 2: LAUNCH THE GAME
echo [2/3] Launching Battlezone Combat Commander...
start "" %*

:: STEP 3: WAIT FOR GAME INITIALIZATION
echo       Waiting 5 seconds for BZCC to boot...
timeout /t 5 >nul

:: STEP 4: LAUNCH THE STATS TRACKER (WITH EXPLICIT WORKING DIRECTORY)
echo [3/3] Starting statslauncher.exe...
start "" /D "%~dp0" "%~dp0statslauncher.exe"

:: SUCCESS ROUTINE
echo.
echo ===================================================
echo SUCCESS: The Stats Tracker has been launched!
echo.
echo Tip: Run 'stats' in the BZCC console to confirm.
echo ===================================================
echo.
echo Closing this helper window automatically in 7 seconds...
timeout /t 15
exit /b

:: ERROR TRAP ROUTINE
:ErrorExit
echo.
echo ===================================================
echo [!] SCRIPT HALTED DUE TO AN ERROR [!]
echo Please review the messages above to troubleshoot.
echo ===================================================
echo.
:: 'pause' keeps the window open indefinitely so the user can read the error
pause
exit /b