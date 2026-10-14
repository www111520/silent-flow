[CmdletBinding()]
param(
    [string]$TaskName = "QQTechInfoCollector",
    [string]$NodeExecutable = "",
    [string]$ModelExecutable = "",
    [string]$ModelPath = "",
    [string]$ModelAlias = "qwen3-4b-instruct",
    [string]$NapCatExecutable = "",
    [string]$NapCatQuickLogin = ""
)

$ErrorActionPreference = "Stop"
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$entryPoint = Join-Path $projectDirectory "dist\src\main.js"
$environmentFile = Join-Path $projectDirectory ".env"

if (-not (Test-Path -LiteralPath $entryPoint)) {
    throw "缺少构建产物，请先运行 pnpm build：$entryPoint"
}
if (-not (Test-Path -LiteralPath $environmentFile)) {
    throw "缺少 .env，请先从 .env.example 复制并填写配置。"
}

$resolvedNode = if ($NodeExecutable) {
    if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
        throw "Node.js 启动程序不存在：$NodeExecutable"
    }
    (Resolve-Path -LiteralPath $NodeExecutable).Path
} else {
    (Get-Command node -ErrorAction Stop).Source
}
$windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
function New-HiddenTaskAction([string]$Runner, [string]$Arguments) {
    $runnerPath = (Resolve-Path (Join-Path $PSScriptRoot $Runner)).Path
    New-ScheduledTaskAction `
        -Execute $windowsPowerShell `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runnerPath`" $Arguments" `
        -WorkingDirectory $projectDirectory
}

$action = New-HiddenTaskAction "run-collector.ps1" "-NodeExecutable `"$resolvedNode`" -ProjectDirectory `"$projectDirectory`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "QQ 群技术信息采集器（当前用户登录后启动）" `
    -Force | Out-Null

Write-Host "已注册当前用户登录启动任务：$TaskName"

if ($ModelExecutable -or $ModelPath) {
    if (-not (Test-Path -LiteralPath $ModelExecutable -PathType Leaf)) {
        throw "本地模型服务不存在：$ModelExecutable"
    }
    if (-not (Test-Path -LiteralPath $ModelPath -PathType Leaf)) {
        throw "本地模型文件不存在：$ModelPath"
    }
    $modelTaskName = "$TaskName-Model"
    $resolvedModelExecutable = (Resolve-Path -LiteralPath $ModelExecutable).Path
    $resolvedModelPath = (Resolve-Path -LiteralPath $ModelPath).Path
    $modelAction = New-HiddenTaskAction "run-model.ps1" "-ModelExecutable `"$resolvedModelExecutable`" -ModelPath `"$resolvedModelPath`" -ModelAlias `"$ModelAlias`""
    Register-ScheduledTask `
        -TaskName $modelTaskName `
        -Action $modelAction `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description "QQ 群技术信息采集器本地模型（当前用户登录后启动）" `
        -Force | Out-Null
    Write-Host "已注册本地模型登录启动任务：$modelTaskName"
}

if ($NapCatExecutable) {
    if (-not (Test-Path -LiteralPath $NapCatExecutable -PathType Leaf)) {
        throw "NapCat 启动程序不存在：$NapCatExecutable"
    }
    $napCatTaskName = "$TaskName-NapCat"
    $resolvedNapCat = (Resolve-Path -LiteralPath $NapCatExecutable).Path
    $napCatAction = New-HiddenTaskAction "run-napcat.ps1" "-NapCatExecutable `"$resolvedNapCat`" -QuickLogin `"$NapCatQuickLogin`""
    Register-ScheduledTask `
        -TaskName $napCatTaskName `
        -Action $napCatAction `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description "NapCat 与 QQ（当前用户登录后启动）" `
        -Force | Out-Null
    Write-Host "已注册 NapCat 登录启动任务：$napCatTaskName"
}
