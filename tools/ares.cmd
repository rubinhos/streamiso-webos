@echo off
rem Runs a webOS CLI command in Docker, for example:
rem   tools\ares.cmd ares-setup-device --list
rem   tools\ares.cmd ares-install --device tv io.github.rubinhos.streamiso_0.1.0_all.ipk
rem The same as tools\ares.ps1 and tools/ares.sh, for Command Prompt and for PowerShell where scripts are not allowed.
rem The image is built the first time. The TV's settings and SSH key stay in .ares\ at the repository root.
rem The current folder is the container's working folder, so give file paths relative to it, with forward slashes.
setlocal
set "IMAGE=streamiso-ares:3.2.6"
for %%I in ("%~dp0..") do set "REPO=%%~fI"

docker image inspect %IMAGE% >nul 2>&1
if errorlevel 1 (
  docker build -t %IMAGE% "%REPO%\tools\ares"
  if errorlevel 1 exit /b 1
)

if not exist "%REPO%\.ares" mkdir "%REPO%\.ares"
rem A terminal is needed for the questions some commands ask. Set ARES_TTY=-i to run without one.
if not defined ARES_TTY set "ARES_TTY=-it"
docker run --rm %ARES_TTY% -v "%REPO%\.ares:/home/ares" -v "%CD%:/work" %IMAGE% %*
exit /b %errorlevel%
