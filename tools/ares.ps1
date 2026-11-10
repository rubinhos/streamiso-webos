# Runs a webOS CLI command in Docker, for example:
#   .\tools\ares.ps1 ares-setup-device --list
#   .\tools\ares.ps1 ares-install --device tv io.github.rubinhos.streamiso_0.1.0_all.ipk
# The image is built the first time. The TV's settings and SSH key stay in .ares\ at the repository root.
# The current folder is the container's working folder, so give file paths relative to it, with forward slashes.
$repo = Split-Path -Parent $PSScriptRoot
$image = "streamiso-ares:3.2.6"

docker image inspect $image *> $null
if ($LASTEXITCODE -ne 0) {
    docker build -t $image (Join-Path $PSScriptRoot "ares")
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$state = Join-Path $repo ".ares"
New-Item -ItemType Directory -Force $state | Out-Null

# A terminal is needed for the questions some commands ask (the passphrase of ares-novacom --getkey).
$interactive = if ([Console]::IsInputRedirected) { "-i" } else { "-it" }
docker run --rm $interactive -v "${state}:/home/ares" -v "$((Get-Location).Path):/work" $image @args
exit $LASTEXITCODE
