@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
echo --- where link ---
where link.exe
echo --- where cl ---
where cl.exe
echo --- cargo ---
cargo --version
echo --- INCLUDE head ---
echo %INCLUDE%
echo --- LIB head ---
echo %LIB%
