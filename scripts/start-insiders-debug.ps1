param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 9239,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$executable = Join-Path $env:LOCALAPPDATA 'Programs/Microsoft VS Code Insiders/Code - Insiders.exe'
$logDirectory = Join-Path $root ('logs/insiders-debug/' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
Start-Transcript -Path (Join-Path $logDirectory 'launcher.log') | Out-Null

try {
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw "VS Code Insiders executable not found: $executable"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $root 'dist/extension.js') -PathType Leaf)) {
        throw 'Development build not found. Run the compile:dev task first.'
    }

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    $listener.Server.ExclusiveAddressUse = $true
    try {
        $listener.Start()
    } catch {
        throw "Debug port $Port is unavailable. Close the previous debug host before starting another session."
    } finally {
        $listener.Stop()
    }

    $startInfo = [Diagnostics.ProcessStartInfo]::new($executable)
    $startInfo.UseShellExecute = $false
    $startInfo.WorkingDirectory = $root
    foreach ($argument in @(
        '--new-window',
        "--inspect-brk-extensions=$Port",
        "--extensionDevelopmentPath=$root",
        '--enable-proposed-api=vicanent.gcmp',
        "--logsPath=$logDirectory",
        $root
    )) {
        $startInfo.ArgumentList.Add($argument)
    }
    foreach ($name in @('ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_INSPECTOR_OPTIONS', 'NODE_OPTIONS')) {
        $startInfo.Environment.Remove($name) | Out-Null
    }

    Write-Output "Insiders executable: $executable"
    Write-Output "Extension inspector port: $Port"
    Write-Output "Logs: $logDirectory"
    if ($CheckOnly) {
        Write-Output 'CHECK PASSED: executable, development build and debugger port are ready.'
        return
    }
    Write-Output 'GCMP_INSIDERS_STARTING'
    $process = [Diagnostics.Process]::Start($startInfo)
    Write-Output "Insiders launcher PID: $($process.Id)"
    $process.Dispose()
    Write-Output 'GCMP_INSIDERS_READY'
} finally {
    Stop-Transcript | Out-Null
}
