# Start the MultiVision AI Manager on Windows (PowerShell). Same as start.sh:
#   .\start.ps1            NVIDIA GPU
#   .\start.ps1 -Cpu       CPU only
#   .\start.ps1 -Update    also pull the latest commits of the module repositories
#   .\start.ps1 -Down      stop and remove the manager and the modules
#
# The modules live in their own repositories (git submodules), downloaded here when missing:
#   modules/yolo  = https://github.com/marcomaggiotti/detect_image_engine
#   modules/clip  = https://github.com/marcomaggiotti/visual-semantic-engine
#   modules/vlm   = https://github.com/marcomaggiotti/vlm_hub_engine
#   modules/audio = https://github.com/marcomaggiotti/audio_clean_service
param([switch]$Cpu, [switch]$Update, [switch]$Down)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$files = @("-f", "docker-compose.yml")
if ($Cpu) { $files += @("-f", "docker-compose.cpu.yml") }

if ($Down) {
    docker compose @files down
    exit $LASTEXITCODE
}

# .gitmodules may have changed with a pull (a new module): align the local configuration first.
git submodule sync --recursive
foreach ($module in @("yolo", "clip", "vlm", "audio")) {
    if (-not (Test-Path "modules/$module/Dockerfile")) {
        Write-Host "Downloading the $module module into modules/$module..."
        git submodule update --init --recursive "modules/$module"
        if ($LASTEXITCODE -ne 0) { throw "could not download modules/$module (see the git message above)" }
    }
    if ($Update) {
        Write-Host "Updating modules/$module to the latest commit of its branch..."
        git submodule update --init --remote "modules/$module"
    }
}

if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" }

Write-Host "Building and starting the manager and the modules..."
docker compose @files up -d --build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host ""
Write-Host "MultiVision AI Manager: http://localhost:3000"
Write-Host "Phones/tablets on the same network: https://<this computer's IP>:3443"
