[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$NapCatExecutable,
    [string]$QuickLogin = ""
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $NapCatExecutable -PathType Leaf)) {
    throw "NapCat 启动程序不存在：$NapCatExecutable"
}

Set-Location -LiteralPath (Split-Path -Parent $NapCatExecutable)
if ($QuickLogin) {
    & $NapCatExecutable $QuickLogin
} else {
    & $NapCatExecutable
}
exit $LASTEXITCODE
