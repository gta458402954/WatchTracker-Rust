param(
    [Parameter(Mandatory)][string]$ContractPath
)

. (Join-Path $PSScriptRoot 'Common.ps1')
$contractInfo = Read-TaskContract $ContractPath
$root = Assert-RepositoryIdentity $contractInfo
$contract = $contractInfo.Value
$sessionId = [guid]::NewGuid().ToString()
$sessionClock = [Diagnostics.Stopwatch]::StartNew()
$taskRoot = Join-Path $root (".agent-work\evidence\generated\{0}\{1}" -f $contract.task_id, $sessionId)
$rawRoot = Join-Path $root (".agent-work\evidence\raw\{0}\{1}" -f $contract.task_id, $sessionId)
New-Item -ItemType Directory -Force -Path $taskRoot, $rawRoot | Out-Null

function Get-RelevantProcesses {
    $expected = ConvertTo-NormalPath ([string]$contract.repository.expected_worktree)
    $result = @()
    Get-CimInstance Win32_Process | ForEach-Object {
        $cmd = [string]$_.CommandLine
        $name = [string]$_.Name
        if ((ConvertTo-NormalPath $cmd) -like "*$expected*" -or $name -match '^(cargo|rustc|clippy|node|npm|pnpm|app|WatchTracker)(\.exe)?$') {
            $creation = $null
            try { $creation = ([Management.ManagementDateTimeConverter]::ToDateTime($_.CreationDate)).ToUniversalTime().ToString('o') } catch {}
            $result += [ordered]@{
                pid = [int]$_.ProcessId
                parent_pid = [int]$_.ParentProcessId
                name = $name
                creation_time_utc = $creation
                executable_path = [string]$_.ExecutablePath
                command_line = $cmd
            }
        }
    }
    return $result
}

function Get-GitSnapshot {
    param([string]$Phase)
    $files = @()
    $fingerprintPaths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($relative in (Get-WorkspaceChangePaths $root)) { [void]$fingerprintPaths.Add($relative) }
    foreach ($pattern in @($contract.workspace_policy.allowed_modified_files)) {
        if ([string]$pattern -notmatch '[*?]') {
            $candidate = ConvertTo-NormalPath ([string]$pattern)
            if (Test-Path -LiteralPath (Join-Path $root ($candidate -replace '/', '\')) -PathType Leaf) { [void]$fingerprintPaths.Add($candidate) }
        }
    }
    foreach ($relative in @($fingerprintPaths | Sort-Object)) {
        $full = Join-Path $root ($relative -replace '/', '\')
        $fingerprint = if (Test-Path -LiteralPath $full -PathType Leaf) { Get-FileFingerprint $full } else { $null }
        $files += [ordered]@{ path = $relative; fingerprint = $fingerprint }
    }
    $environment = [ordered]@{}
    foreach ($name in @($contract.evidence.environment_allowlist)) {
        $value = [Environment]::GetEnvironmentVariable([string]$name)
        $environment[[string]$name] = [ordered]@{ is_set = $null -ne $value; value = $value }
    }
    return [ordered]@{
        phase = $Phase
        captured_at_utc = [DateTime]::UtcNow.ToString('o')
        session_offset_ms = $sessionClock.ElapsedMilliseconds
        head = Invoke-GitText @('rev-parse','HEAD') $root
        branch = Invoke-GitText @('branch','--show-current') $root
        porcelain_v2 = Invoke-GitText @('status','--porcelain=v2','--untracked-files=all') $root
        ignored = Invoke-GitText @('status','--porcelain=v2','--ignored=matching') $root
        staged = @(Get-StagedPaths $root)
        files = $files
        processes = @(Get-RelevantProcesses)
        environment = $environment
    }
}

$preflight = Get-GitSnapshot 'preflight'
Write-JsonUtf8 $preflight (Join-Path $taskRoot 'preflight.json')
if (@($preflight.staged).Count -ne 0) { throw 'Preflight staged index is not empty; refusing to run.' }

$results = @()
$failedSteps = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($step in @($contract.steps)) {
    $dependencyFailed = $false
    foreach ($requirement in @($step.requires)) {
        if ($failedSteps.Contains([string]$requirement)) { $dependencyFailed = $true }
    }
    if ($dependencyFailed) {
        $blocked = [ordered]@{ schema_version = 1; session_id = $sessionId; task_id = $contract.task_id; step_id = $step.id; result = 'BLOCKED_BY_PREVIOUS_STEP'; contract_sha256 = $contractInfo.Sha256 }
        Write-JsonUtf8 $blocked (Join-Path $taskRoot ("step-{0}.json" -f $step.id))
        $results += $blocked
        [void]$failedSteps.Add([string]$step.id)
        continue
    }

    $stdoutPath = Join-Path $rawRoot ("{0}.stdout.txt" -f $step.id)
    $stderrPath = Join-Path $rawRoot ("{0}.stderr.txt" -f $step.id)
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = [string]$step.executable
    foreach ($argument in @($step.arguments)) { [void]$psi.ArgumentList.Add([string]$argument) }
    $psi.WorkingDirectory = Join-Path $root ([string]$step.cwd -replace '/', '\')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $psi
    $startedAt = [DateTime]::UtcNow
    $startedOffset = $sessionClock.ElapsedMilliseconds
    if (-not $process.Start()) { throw "Unable to start step $($step.id)" }
    $identity = [ordered]@{ pid = $process.Id; creation_time_utc = $process.StartTime.ToUniversalTime().ToString('o'); executable = $psi.FileName; arguments = @($step.arguments) }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $timedOut = $false
    $terminatedByRunner = $false
    $observed = [int]$step.observation_seconds -gt 0

    if ($observed) {
        $exitedDuringObservation = $process.WaitForExit([int]$step.observation_seconds * 1000)
        if (-not $exitedDuringObservation) {
            $current = Get-Process -Id $identity.pid -ErrorAction Stop
            if ($current.StartTime.ToUniversalTime().ToString('o') -cne $identity.creation_time_utc) { throw 'Process identity changed before termination.' }
            $process.Kill($true)
            $terminatedByRunner = $true
            $process.WaitForExit()
        }
    } else {
        if (-not $process.WaitForExit([int]$step.timeout_seconds * 1000)) {
            $timedOut = $true
            $current = Get-Process -Id $identity.pid -ErrorAction Stop
            if ($current.StartTime.ToUniversalTime().ToString('o') -cne $identity.creation_time_utc) { throw 'Process identity changed before timeout termination.' }
            $process.Kill($true)
            $terminatedByRunner = $true
            $process.WaitForExit()
        }
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    [IO.File]::WriteAllText($stdoutPath, $stdout, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($stderrPath, $stderr, [Text.UTF8Encoding]::new($false))
    $exitCode = $process.ExitCode
    $endedAt = [DateTime]::UtcNow
    $endedOffset = $sessionClock.ElapsedMilliseconds
    $health = $null
    if ($observed) {
        if ($step.health_stdout_regex) { $health = if ($stdout -match [string]$step.health_stdout_regex) { 'PASS' } else { 'FAIL' } }
        else { $health = if ($terminatedByRunner) { 'PASS' } else { 'FAIL' } }
    }
    $result = if ($timedOut) { 'TIMED_OUT' } elseif ($observed -and $terminatedByRunner) { 'OBSERVED_THEN_TERMINATED' } elseif ($exitCode -eq 0) { 'SUCCEEDED' } else { 'FAILED' }
    $manifest = [ordered]@{
        schema_version = 1
        session_id = $sessionId
        task_id = $contract.task_id
        step_id = $step.id
        contract_path = ConvertTo-NormalPath ([IO.Path]::GetRelativePath($root, $contractInfo.Path))
        contract_sha256 = $contractInfo.Sha256
        executable = $step.executable
        arguments = @($step.arguments)
        cwd = ConvertTo-NormalPath $psi.WorkingDirectory
        started_at_utc = $startedAt.ToString('o')
        ended_at_utc = $endedAt.ToString('o')
        started_offset_ms = $startedOffset
        ended_offset_ms = $endedOffset
        duration_ms_monotonic = $endedOffset - $startedOffset
        raw_exit_code = $exitCode
        result = $result
        health_check = $health
        timed_out = $timedOut
        terminated_by_runner = $terminatedByRunner
        process = $identity
        stdout_log = ConvertTo-NormalPath ([IO.Path]::GetRelativePath($root, $stdoutPath))
        stderr_log = ConvertTo-NormalPath ([IO.Path]::GetRelativePath($root, $stderrPath))
    }
    Write-JsonUtf8 $manifest (Join-Path $taskRoot ("step-{0}.json" -f $step.id))
    $results += $manifest
    if ($result -in @('FAILED','TIMED_OUT') -and [string]$step.on_nonzero -eq 'STOP') { [void]$failedSteps.Add([string]$step.id) }
}

$postContractHash = Get-NormalizedTextSha256 $contractInfo.Path
if ($postContractHash -cne $contractInfo.Sha256) { throw 'Task contract changed during execution.' }
$postflight = Get-GitSnapshot 'postflight'
Write-JsonUtf8 $postflight (Join-Path $taskRoot 'postflight.json')
$summary = [ordered]@{
    schema_version = 1
    session_id = $sessionId
    task_id = $contract.task_id
    contract_sha256 = $contractInfo.Sha256
    session_started_at_utc = ([DateTime]::UtcNow - $sessionClock.Elapsed).ToString('o')
    session_ended_at_utc = [DateTime]::UtcNow.ToString('o')
    duration_ms_monotonic = $sessionClock.ElapsedMilliseconds
    steps = $results
}
Write-JsonUtf8 $summary (Join-Path $taskRoot 'task-summary.json')
Write-Output (Join-Path $taskRoot 'task-summary.json')
