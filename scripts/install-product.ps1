[CmdletBinding()]
param(
    [string]$InstallDirectory = "D:\QQTechInfoCollector",
    [string]$NodeExecutable = "",
    [string]$ModelExecutable = "",
    [string]$ModelPath = "",
    [string]$ModelAlias = "qwen3-4b-instruct",
    [string]$NapCatExecutable = "",
    [string]$NapCatQuickLogin = ""
)

$ErrorActionPreference = "Stop"
$sourceDirectory = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$targetDirectory = [IO.Path]::GetFullPath($InstallDirectory)
if ($targetDirectory -eq $sourceDirectory) {
    throw "安装目录不能与源码目录相同。"
}
if (-not (Test-Path (Join-Path $sourceDirectory "dist\src\main.js"))) {
    throw "缺少构建产物，请先运行 pnpm build。"
}

New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
foreach ($file in @("package.json", "pnpm-lock.yaml", ".env")) {
    Copy-Item -LiteralPath (Join-Path $sourceDirectory $file) -Destination $targetDirectory -Force
}
foreach ($directory in @("dist", "node_modules", "scripts")) {
    Copy-Item -LiteralPath (Join-Path $sourceDirectory $directory) -Destination $targetDirectory -Recurse -Force
}
if (-not (Test-Path (Join-Path $targetDirectory "data"))) {
    Copy-Item -LiteralPath (Join-Path $sourceDirectory "data") -Destination $targetDirectory -Recurse
}

$startup = Join-Path $targetDirectory "scripts\install-startup.ps1"
& $startup `
    -NodeExecutable $NodeExecutable `
    -ModelExecutable $ModelExecutable `
    -ModelPath $ModelPath `
    -ModelAlias $ModelAlias `
    -NapCatExecutable $NapCatExecutable `
    -NapCatQuickLogin $NapCatQuickLogin

$shortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "技术信息控制台.url"
@"
[InternetShortcut]
URL=http://127.0.0.1:3002/
IconFile=$env:SystemRoot\System32\shell32.dll
IconIndex=13
"@ | Set-Content -LiteralPath $shortcut -Encoding ASCII

Start-ScheduledTask -TaskName "QQTechInfoCollector"
if ($ModelExecutable) { Start-ScheduledTask -TaskName "QQTechInfoCollector-Model" }
if ($NapCatExecutable) { Start-ScheduledTask -TaskName "QQTechInfoCollector-NapCat" }

Write-Host "安装完成：$targetDirectory"
Write-Host "桌面快捷方式：$shortcut"
