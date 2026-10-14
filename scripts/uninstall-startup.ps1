[CmdletBinding()]
param(
    [string]$TaskName = "QQTechInfoCollector"
)

$ErrorActionPreference = "Stop"
foreach ($name in @($TaskName, "$TaskName-Model", "$TaskName-NapCat")) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        Write-Host "启动任务不存在，无需删除：$name"
        continue
    }

    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "已删除启动任务：$name"
}
