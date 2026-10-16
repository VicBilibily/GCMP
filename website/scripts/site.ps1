param(
    [ValidateSet('dev', 'preview', 'build', 'typecheck')]
    [string]$Mode = 'dev',
    [ValidateRange(1024, 65535)]
    [int]$Port = 5173
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$siteRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path (Split-Path -Parent $siteRoot) 'logs'
[System.IO.Directory]::CreateDirectory($logDirectory) | Out-Null
$logPath = Join-Path $logDirectory ('website-{0}-{1}.log' -f $Mode, (Get-Date -Format 'yyyyMMdd-HHmmss'))
$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
$commandExitCode = 1

Push-Location -LiteralPath $siteRoot
try {
    if ($Mode -in @('dev', 'preview')) {
        & $npmCommand run $Mode -- --host 127.0.0.1 --port $Port 2>&1 |
            Tee-Object -FilePath $logPath
    }
    else {
        & $npmCommand run $Mode 2>&1 | Tee-Object -FilePath $logPath
    }
    $commandExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

exit $commandExitCode
