[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ModelExecutable,
    [Parameter(Mandatory = $true)]
    [string]$ModelPath,
    [Parameter(Mandatory = $true)]
    [string]$ModelAlias
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $ModelExecutable -PathType Leaf)) {
    throw "本地模型服务不存在：$ModelExecutable"
}
if (-not (Test-Path -LiteralPath $ModelPath -PathType Leaf)) {
    throw "本地模型文件不存在：$ModelPath"
}

Set-Location -LiteralPath (Split-Path -Parent $ModelExecutable)
& $ModelExecutable -m $ModelPath --alias $ModelAlias --host 127.0.0.1 --port 11434 -ngl 99 -c 4096 --no-webui
exit $LASTEXITCODE
