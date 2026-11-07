@echo off
setlocal EnableExtensions
chcp 65001 >nul
set "PYTHONUTF8=1"
pushd "%~dp0"
python -m titan_research %*
set "TITAN_EXIT=%ERRORLEVEL%"
popd
exit /b %TITAN_EXIT%
