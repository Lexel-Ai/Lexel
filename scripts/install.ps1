#Requires -Version 5.1
param(
    [switch]$WithModels,
    [string]$ExtensionId = ""
)

$ErrorActionPreference = "Stop"

$ReleasesBase = "https://github.com/Lexel-Ai/Lexel/releases/latest/download"
$Target = "windows-x86_64"
$LexelDataDir = Join-Path $env:APPDATA "lexel"
$BinDir = Join-Path $LexelDataDir "bin"
$ExtDir = Join-Path $LexelDataDir "extensions"
$ModelsDir = Join-Path $LexelDataDir "models"

New-Item -ItemType Directory -Force -Path $BinDir, $ExtDir, $ModelsDir | Out-Null

Write-Host "========================================================"
Write-Host " Lexel Installer ($Target)"
Write-Host "========================================================"
Write-Host "Install bin dir : $BinDir"
Write-Host "Data directory  : $LexelDataDir"

Write-Host "[1/4] Downloading CLI, Daemon, and LSP binaries..."
Invoke-WebRequest -Uri "$ReleasesBase/lexel-daemon-$Target.exe" -OutFile (Join-Path $BinDir "lexel-daemon.exe")
Invoke-WebRequest -Uri "$ReleasesBase/lexel-cli-$Target.exe" -OutFile (Join-Path $BinDir "lexel.exe")
Invoke-WebRequest -Uri "$ReleasesBase/lexel-ls-$Target.exe" -OutFile (Join-Path $BinDir "lexel-ls.exe")

Write-Host "[2/4] Downloading Lexel Desktop installer..."
$DesktopInstaller = Join-Path $LexelDataDir "lexel-desktop-$Target-setup.exe"
try {
    Invoke-WebRequest -Uri "$ReleasesBase/lexel-desktop-$Target-setup.exe" -OutFile $DesktopInstaller
    Write-Host "[ok] Saved Desktop installer to $DesktopInstaller"
    Write-Host "     Launching Lexel Desktop installer..."
    Start-Process -FilePath $DesktopInstaller -Wait
} catch {
    Write-Warning "Could not download .exe setup installer; trying .msi..."
    $MsiInstaller = Join-Path $LexelDataDir "lexel-desktop-$Target.msi"
    Invoke-WebRequest -Uri "$ReleasesBase/lexel-desktop-$Target.msi" -OutFile $MsiInstaller
    Start-Process msiexec.exe -ArgumentList "/i `"$MsiInstaller`"" -Wait
}

Write-Host "[3/4] Downloading Browser, VS Code, and Obsidian extension archives..."
foreach ($zip in @("lexel-chrome.zip", "lexel-firefox.zip", "lexel-obsidian-plugin.zip", "lexel-vscode.zip")) {
    try {
        Invoke-WebRequest -Uri "$ReleasesBase/$zip" -OutFile (Join-Path $ExtDir $zip)
        Write-Host "[ok] Saved $ExtDir\$zip"
    } catch {
        Write-Warning "Skipped optional archive $zip"
    }
}

Write-Host "[4/4] Registering Browser Native Messaging Bridge and PATH..."
$DaemonBin = Join-Path $BinDir "lexel-daemon.exe"
& $DaemonBin token | Out-Null
if ($ExtensionId -ne "") {
    & $DaemonBin install-native-host --extension-id $ExtensionId | Out-Null
} else {
    & $DaemonBin install-native-host | Out-Null
}

$CurrentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($CurrentUserPath -notlike "*$BinDir*") {
    $NewPath = if ([string]::IsNullOrEmpty($CurrentUserPath)) { $BinDir } else { "$CurrentUserPath;$BinDir" }
    [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
    Write-Host "[ok] Added $BinDir to your user PATH (restart terminal to use 'lexel' and 'lexel-ls')."
}

if ($WithModels) {
    Write-Host "[models] Downloading verified local AI models..."
    & $DaemonBin download-model lexel-1.5b
    & $DaemonBin download-model lexel-0.5b
}

Write-Host ""
Write-Host "Lexel installation complete! Launch Lexel Desktop from the Start Menu."
