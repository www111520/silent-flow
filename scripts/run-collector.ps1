[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$NodeExecutable,
    [Parameter(Mandatory = $true)]
    [string]$ProjectDirectory
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
    throw "Node.js 启动程序不存在：$NodeExecutable"
}
if (-not (Test-Path -LiteralPath $ProjectDirectory -PathType Container)) {
    throw "项目目录不存在：$ProjectDirectory"
}

Set-Location -LiteralPath $ProjectDirectory
& $NodeExecutable --env-file=.env dist/src/main.js
exit $LASTEXITCODE
