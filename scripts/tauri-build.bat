@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
cd /d C:\Users\hp\Documents\GitHub\radiant-biz-panel
echo --- npm run build (vite production) ---
call npm run build
if errorlevel 1 exit /b 1
echo --- tauri build (release) ---
call npx tauri build
if errorlevel 1 exit /b 1
echo --- artifacts ---
dir /b /s "src-tauri\target\release\bundle" 2>nul
