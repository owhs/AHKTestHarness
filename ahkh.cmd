@echo off
rem ahkh launcher: prefers bun (fast start), falls back to node. Override with AHKH_RUNTIME=node|bun.
setlocal
set "RT=%AHKH_RUNTIME%"
if "%RT%"=="" (
  where bun >nul 2>&1 && (set "RT=bun") || (set "RT=node")
)
"%RT%" "%~dp0bin\ahkh.mjs" %*
exit /b %ERRORLEVEL%
