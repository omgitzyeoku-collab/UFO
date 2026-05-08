# Install a Windows scheduled task that runs the UFO archive tick daily.
# Run from PowerShell as the current user (no admin required for user-scope tasks).
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-scheduled-task.ps1
#
# To uninstall:
#   Unregister-ScheduledTask -TaskName "UFO-Archive-Tick" -Confirm:$false

$ErrorActionPreference = "Stop"
$Root      = (Resolve-Path "$PSScriptRoot\..").Path
$NodeExe   = (Get-Command node).Source
$TickPath  = Join-Path $Root "scripts\tick.mjs"
$LogPath   = Join-Path $Root "scripts\tick.log"

if (!(Test-Path $TickPath)) {
    throw "tick.mjs not found at $TickPath"
}

$Action = New-ScheduledTaskAction `
    -Execute  $NodeExe `
    -Argument "`"$TickPath`"" `
    -WorkingDirectory $Root

# Run once daily at 09:00 local time
$Trigger = New-ScheduledTaskTrigger -Daily -At 9:00am

# Run only when the user is logged on (interactive Chrome required for Akamai bypass)
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 10)

Register-ScheduledTask `
    -TaskName "UFO-Archive-Tick" `
    -Description "Daily crawl + diff of war.gov/UFO/. Alerts via Vega/Telegram on change." `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Force | Out-Null

Write-Host "Installed scheduled task 'UFO-Archive-Tick' (daily, 09:00 local)."
Write-Host "First run will execute at the next 09:00 local time."
Write-Host "To run on demand: Start-ScheduledTask -TaskName UFO-Archive-Tick"
Write-Host "To inspect:       Get-ScheduledTask -TaskName UFO-Archive-Tick"
Write-Host "To remove:        Unregister-ScheduledTask -TaskName UFO-Archive-Tick -Confirm:`$false"
