#!/bin/sh
# Runs a webOS CLI command in Docker, for example:
#   tools/ares.sh ares-setup-device --list
#   tools/ares.sh ares-install --device tv io.github.rubinhos.streamiso_0.1.0_all.ipk
# The image is built the first time. The TV's settings and SSH key stay in .ares/ at the repository root.
# The current folder is the container's working folder, so give file paths relative to it.
set -e
repo=$(cd "$(dirname "$0")/.." && pwd)
image=streamiso-ares:3.2.6

docker image inspect "$image" > /dev/null 2>&1 || docker build -t "$image" "$repo/tools/ares"

mkdir -p "$repo/.ares"
# Git Bash on Windows: Docker needs C:/... paths, and the container paths must not be rewritten.
state=$(cd "$repo/.ares" && (pwd -W 2> /dev/null || pwd))
work=$(pwd -W 2> /dev/null || pwd)
export MSYS_NO_PATHCONV=1

# A terminal is needed for the questions some commands ask (the passphrase of ares-novacom --getkey).
if [ -t 0 ]; then tty=-it; else tty=-i; fi
exec docker run --rm $tty -v "$state:/home/ares" -v "$work:/work" "$image" "$@"
