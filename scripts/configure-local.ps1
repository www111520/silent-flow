[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+(,\d+)*$')]
    [string]$GroupWhitelist,
    [string]$ModelAlias = "qwen3-4b-instruct",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$environmentFile = Join-Path $projectDirectory ".env"

if ((Test-Path -LiteralPath $environmentFile) -and -not $Force) {
    throw ".env 已存在；如需重新生成，请显式传入 -Force。"
}

function New-LocalSecret([int]$ByteCount) {
    $bytes = New-Object byte[] $ByteCount
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToHexString($bytes).ToLowerInvariant()
}

$lines = @(
    "DB_PATH=data/collector.sqlite"
    "ONEBOT_HOST=127.0.0.1"
    "ONEBOT_PORT=3001"
    "ONEBOT_TOKEN=$(New-LocalSecret 32)"
    "ADMIN_HOST=0.0.0.0"
    "ADMIN_PORT=3002"
    "ADMIN_TOKEN=$(New-LocalSecret 32)"
    "SENDER_SALT=$(New-LocalSecret 24)"
    "GROUP_WHITELIST=$GroupWhitelist"
    "LLM_BASE_URL=http://127.0.0.1:11434/v1"
    "LLM_MODEL=$ModelAlias"
    "LLM_TIMEOUT_MS=60000"
    "BACKUP_DIR=data/backups"
    "BACKUP_INTERVAL_MS=86400000"
    "BACKUP_KEEP_COUNT=7"
    "RESERVE_PATH=data/emergency.reserve"
    "RESERVE_BYTES=268435456"
    "MIN_FREE_BYTES=1073741824"
)

[IO.File]::WriteAllLines($environmentFile, $lines, [Text.UTF8Encoding]::new($false))
Write-Host "已生成本机配置：$environmentFile（群白名单：$GroupWhitelist）"
