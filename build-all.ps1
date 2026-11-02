Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$desktopDir = Join-Path $repoRoot "apps\desktop"
$cliExe = Join-Path $repoRoot "target\release\orchestrator-tool.exe"
$desktopExe = Join-Path $desktopDir "src-tauri\target\release\Orchestrator Tool.exe"
$outputDir = Join-Path $repoRoot "dist\windows-x64"

# Do not reuse an earlier successful artifact after a failed build.
if (Test-Path -LiteralPath $outputDir) {
    Remove-Item -LiteralPath $outputDir -Recurse -Force
}

Push-Location $repoRoot
try {
    Write-Host "Building CLI..."
    & cargo build --release --locked --bin orchestrator-tool
    if ($LASTEXITCODE -ne 0) { throw "CLI build failed (exit $LASTEXITCODE)." }

    Write-Host "Building Tauri Desktop..."
    Push-Location $desktopDir
    try {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)." }

        & npm.cmd run tauri -- build --no-bundle -- --locked
        if ($LASTEXITCODE -ne 0) { throw "Desktop build failed (exit $LASTEXITCODE)." }
    }
    finally {
        Pop-Location
    }

    foreach ($exe in @($cliExe, $desktopExe)) {
        if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
            throw "Expected EXE not found: $exe"
        }
        if ((Get-Item -LiteralPath $exe).Length -le 0) {
            throw "Expected EXE is empty: $exe"
        }
    }

    Write-Host "Checking CLI startup..."
    & $cliExe --help | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "CLI --help failed (exit $LASTEXITCODE)." }
    & $cliExe --version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "CLI --version failed (exit $LASTEXITCODE)." }

    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    Copy-Item -LiteralPath $cliExe -Destination (Join-Path $outputDir "orchestrator-tool.exe")
    Copy-Item -LiteralPath $desktopExe -Destination (Join-Path $outputDir "Orchestrator Tool.exe")

    foreach ($name in @("orchestrator-tool.exe", "Orchestrator Tool.exe")) {
        $outputExe = Join-Path $outputDir $name
        if (-not (Test-Path -LiteralPath $outputExe -PathType Leaf)) {
            throw "Output EXE not found: $outputExe"
        }
        if ((Get-Item -LiteralPath $outputExe).Length -le 0) {
            throw "Output EXE is empty: $outputExe"
        }
    }
    Write-Host "Windows CLI and Desktop EXEs: $outputDir"
}
finally {
    Pop-Location
}
