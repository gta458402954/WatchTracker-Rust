param(
    [Parameter(Mandatory)][string]$ContractPath,
    [Parameter(Mandatory)][string]$ExpectedContractBytesSha256,
    [Parameter(Mandatory)][string]$ExpectedRepositoryId,
    [Parameter(Mandatory)][string]$ExpectedTaskId
)

. (Join-Path $PSScriptRoot 'Common.ps1')
$governanceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$sessionId=[guid]::NewGuid().ToString(); $clock=[Diagnostics.Stopwatch]::StartNew(); $lock=$null; $statePath=$null; $taskId=$ExpectedTaskId

function Get-ProcessRecord([object]$Process) {
    $creation=$null; try{$creation=([Management.ManagementDateTimeConverter]::ToDateTime($Process.CreationDate)).ToUniversalTime().ToString('o')}catch{}
    return [ordered]@{pid=[int]$Process.ProcessId;parent_pid=[int]$Process.ParentProcessId;name=[string]$Process.Name;creation_time_utc=$creation;executable_path=[string]$Process.ExecutablePath;command_line=[string]$Process.CommandLine;observed_at_utc=[DateTime]::UtcNow.ToString('o');session_offset_ms=$clock.ElapsedMilliseconds}
}
function Get-DescendantRecords([int]$RootPid) {
    $all=@(Get-CimInstance Win32_Process); $wanted=[Collections.Generic.HashSet[int]]::new(); [void]$wanted.Add($RootPid); $changed=$true
    while($changed){$changed=$false;foreach($p in $all){if($wanted.Contains([int]$p.ParentProcessId)-and-not$wanted.Contains([int]$p.ProcessId)){[void]$wanted.Add([int]$p.ProcessId);$changed=$true}}}
    return @($all|Where-Object{$wanted.Contains([int]$_.ProcessId)}|ForEach-Object{Get-ProcessRecord $_})
}
function Test-RootIdentity($Identity) {
    $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($Identity.pid)" -ErrorAction SilentlyContinue; if(-not$p){return $false}; $r=Get-ProcessRecord $p
    return $r.creation_time_utc-ceq$Identity.creation_time_utc -and $r.executable_path-ceq$Identity.executable_path -and $r.command_line-ceq$Identity.command_line -and $r.parent_pid-eq$Identity.parent_pid
}
function Get-GitSnapshot([string]$Phase,$Contract,$Root) {
    $files=@();$set=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal);foreach ($p in (Get-WorkspaceChangePaths $Root)){[void]$set.Add($p)};foreach ($pattern in @($Contract.workspace_policy.allowed_modified_files)){if([string]$pattern-notmatch'[*?]'){$candidate=ConvertTo-NormalPath([string]$pattern);$full=Join-Path $Root($candidate-replace'/','\');if(Test-Path -LiteralPath $full -PathType Leaf){[void]$set.Add($candidate)}}}
    foreach ($relative in @($set|Sort-Object)){$full=Join-Path $Root($relative-replace'/','\');$files+=[ordered]@{path=$relative;fingerprint=if(Test-Path -LiteralPath $full -PathType Leaf){Get-FileFingerprint $full}else{$null}}}
    $environment=[ordered]@{};foreach ($name in @($Contract.evidence.environment_allowlist)){$environment[[string]$name]=[ordered]@{is_set=$null-ne[Environment]::GetEnvironmentVariable([string]$name)}};foreach ($name in @($Contract.evidence.sensitive_names)){$environment[[string]$name]=[ordered]@{is_set=$null-ne[Environment]::GetEnvironmentVariable([string]$name);sensitive=$true}}
    return [ordered]@{phase=$Phase;captured_at_utc=[DateTime]::UtcNow.ToString('o');session_offset_ms=$clock.ElapsedMilliseconds;head=Invoke-GitText @('rev-parse','HEAD') $Root;branch=Invoke-GitText @('branch','--show-current') $Root;porcelain_v2=Invoke-GitText @('status','--porcelain=v2','--untracked-files=all') $Root;ignored=Invoke-GitText @('status','--porcelain=v2','--ignored=matching') $Root;staged=@(Get-StagedPaths $Root);files=$files;environment=$environment}
}

try {
    $contractInfo=Read-TaskContractSnapshot $ContractPath $ExpectedContractBytesSha256 $ExpectedTaskId $governanceRoot; $contract=$contractInfo.Value
    if([string]$contract.repository.repository_id-cne$ExpectedRepositoryId){Exit-ControlError 10 'preflight' $taskId 'Expected Repository ID differs from contract.' $null @{}}
    $root=Assert-RepositoryIdentity $contractInfo; $governanceStart=Get-GovernanceToolSnapshot $contractInfo
    $commonGitDir=Invoke-GitText @('rev-parse','--path-format=absolute','--git-common-dir') $root
    try{$lock=Acquire-WorktreeLock $commonGitDir $ExpectedRepositoryId $root $taskId $sessionId}catch{if($_.Exception.Message-eq'CONCURRENT_SESSION'){Exit-ControlError 26 'preflight' $taskId 'An active Runner already owns this worktree.' $null @{}};if($_.Exception.Message-eq'STALE_SESSION_REQUIRES_RECOVERY'){Exit-ControlError 27 'preflight' $taskId 'A stale lock requires explicit Codex recovery.' $null @{}};throw}
    $taskRoot=Join-Path $root(".agent-work\evidence\generated\{0}\{1}"-f$taskId,$sessionId);$capturedRoot=Join-Path $root(".agent-work\evidence\captured\{0}\{1}"-f$taskId,$sessionId);New-Item -ItemType Directory -Force -Path $taskRoot,$capturedRoot|Out-Null
    $statePath=Join-Path $commonGitDir("codex-sessions\{0}\{1}\session-state.json"-f$taskId,$sessionId);[void](Set-SessionState $statePath $taskId $sessionId 'CREATED' @{contract_bytes_sha256=$contractInfo.BytesSha256})
    $preflight=Get-GitSnapshot 'preflight' $contract $root;Write-JsonUtf8Atomic $preflight(Join-Path $taskRoot 'preflight.json');if(@($preflight.staged).Count-ne0){throw 'STAGING_POLICY_VIOLATION: preflight index is not empty.'};[void](Set-SessionState $statePath $taskId $sessionId 'PREFLIGHT_PASSED' @{});[void](Set-SessionState $statePath $taskId $sessionId 'RUNNING' @{})
    $results=@();$failed=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal);$knownProcesses=@()
    foreach ($step in @($contract.steps)) {
        $dependencyFailed=$false
        foreach ($required in @($step.requires)) { if($failed.Contains([string]$required)){$dependencyFailed=$true} }
        if($dependencyFailed) {
            $m=[ordered]@{schema_version=2;session_id=$sessionId;task_id=$taskId;step_id=$step.id;result='BLOCKED_BY_PREVIOUS_STEP';contract_bytes_sha256=$contractInfo.BytesSha256}
            Write-JsonUtf8Atomic $m (Join-Path $taskRoot("step-{0}.json"-f$step.id));$results+=$m;[void]$failed.Add([string]$step.id);continue
        }
        foreach ($arg in @($step.arguments)) {
            foreach ($secretName in @($contract.evidence.sensitive_names)) {
                $secret=[Environment]::GetEnvironmentVariable([string]$secretName)
                if([bool]$contract.evidence.forbid_sensitive_command_line -and -not [string]::IsNullOrEmpty($secret) -and ([string]$arg).Contains($secret)){Exit-ControlError 29 'runner' $taskId "Sensitive value appears in command line: $secretName" $null @{step_id=$step.id}}
            }
        }
        $stdoutPath=Join-Path $capturedRoot("{0}.stdout.txt"-f$step.id);$stderrPath=Join-Path $capturedRoot("{0}.stderr.txt"-f$step.id)
        $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=[string]$step.executable
        foreach ($arg in @($step.arguments)){[void]$psi.ArgumentList.Add([string]$arg)}
        $psi.WorkingDirectory=Join-Path $root([string]$step.cwd-replace'/','\');$psi.UseShellExecute=$false;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.CreateNoWindow=$true
        $process=[Diagnostics.Process]::new();$process.StartInfo=$psi;$startedAt=[DateTime]::UtcNow;$startedOffset=$clock.ElapsedMilliseconds
        if(-not$process.Start()){throw "Unable to start step $($step.id)"}
        Start-Sleep -Milliseconds 60;$rootCim=Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)";$identity=Get-ProcessRecord $rootCim;$observations=@();$stdoutTask=$process.StandardOutput.ReadToEndAsync();$stderrTask=$process.StandardError.ReadToEndAsync();$timedOut=$false;$terminated=$false;$observed=[int]$step.observation_seconds-gt0;$deadline=if($observed){[int]$step.observation_seconds*1000}else{[int]$step.timeout_seconds*1000};$stepClock=[Diagnostics.Stopwatch]::StartNew()
        while(-not$process.HasExited-and$stepClock.ElapsedMilliseconds-lt$deadline){$tree=@(Get-DescendantRecords $process.Id);$observations+=@($tree);$knownProcesses+=@($tree);Start-Sleep -Milliseconds 200}
        if(-not$process.HasExited){if(-not(Test-RootIdentity $identity)){throw 'Process identity changed before termination.'};if($observed){$terminated=$true}else{$timedOut=$true;$terminated=$true};$process.Kill($true);$process.WaitForExit()}
        $stdout=Protect-SensitiveText ($stdoutTask.GetAwaiter().GetResult()) $contract.evidence;$stderr=Protect-SensitiveText ($stderrTask.GetAwaiter().GetResult()) $contract.evidence
        [IO.File]::WriteAllText($stdoutPath,$stdout,[Text.UTF8Encoding]::new($false));[IO.File]::WriteAllText($stderrPath,$stderr,[Text.UTF8Encoding]::new($false));$exit=$process.ExitCode;$endedAt=[DateTime]::UtcNow;$endedOffset=$clock.ElapsedMilliseconds;$health=$null
        if($observed){$health=if($step.health_stdout_regex){if($stdout-match[string]$step.health_stdout_regex){'PASS'}else{'FAIL'}}elseif($terminated){'PASS'}else{'FAIL'}}
        $result=if($timedOut){'TIMED_OUT'}elseif($observed-and$terminated){'OBSERVED_THEN_TERMINATED'}elseif($exit-eq0){'SUCCEEDED'}else{'FAILED'}
        $safeArguments=@($step.arguments|ForEach-Object{Protect-SensitiveText ([string]$_) $contract.evidence})
        $manifest=[ordered]@{schema_version=2;session_id=$sessionId;task_id=$taskId;step_id=$step.id;contract_path=ConvertTo-NormalPath $contractInfo.Path;contract_bytes_sha256=$contractInfo.BytesSha256;contract_normalized_sha256=$contractInfo.NormalizedSha256;executable=$step.executable;arguments=$safeArguments;cwd=ConvertTo-NormalPath $psi.WorkingDirectory;started_at_utc=$startedAt.ToString('o');ended_at_utc=$endedAt.ToString('o');started_offset_ms=$startedOffset;ended_offset_ms=$endedOffset;duration_ms_monotonic=$endedOffset-$startedOffset;raw_exit_code=$exit;result=$result;health_check=$health;timed_out=$timedOut;terminated_by_runner=$terminated;process=$identity;process_tree=@($observations|Sort-Object pid,creation_time_utc -Unique);capture_policy='REDACT_AT_INGRESS';redaction_applied=$true;redaction_rules_version=[int]$contract.evidence.redaction_rules_version;stdout_log=ConvertTo-NormalPath([IO.Path]::GetRelativePath($root,$stdoutPath));stderr_log=ConvertTo-NormalPath([IO.Path]::GetRelativePath($root,$stderrPath))}
        Write-JsonUtf8Atomic $manifest (Join-Path $taskRoot("step-{0}.json"-f$step.id));$results+=$manifest
        if($result-in@('FAILED','TIMED_OUT')-and[string]$step.on_nonzero-eq'STOP'){[void]$failed.Add([string]$step.id)}
    }
    Start-Sleep -Milliseconds 500;$residual=@();foreach ($known in @($knownProcesses|Sort-Object pid,creation_time_utc -Unique)){$p=Get-CimInstance Win32_Process -Filter "ProcessId=$($known.pid)" -ErrorAction SilentlyContinue;if($p){$current=Get-ProcessRecord $p;if($current.creation_time_utc-ceq$known.creation_time_utc-and((ConvertTo-NormalPath $current.command_line)-like'*'+(ConvertTo-NormalPath $root)+'*')){$residual+=$current}}};if($residual.Count){Exit-ControlError 16 'postflight' $taskId 'Task-owned process remains after execution.' $null @{processes=$residual}}
    if((Get-Sha256 $contractInfo.Path)-cne$contractInfo.BytesSha256){Exit-ControlError 20 'postflight' $taskId 'Contract bytes changed during execution.' $contractInfo.Path @{}}
    $governanceEnd=Get-GovernanceToolSnapshot $contractInfo
    $governanceChanged=$governanceStart.head-cne$governanceEnd.head-or(($governanceStart.tool_sha256|ConvertTo-Json -Compress)-cne($governanceEnd.tool_sha256|ConvertTo-Json -Compress))
    if(-not[bool]$contract.governance.bootstrap){$governanceChanged=$governanceChanged-or$governanceStart.status-cne$governanceEnd.status}
    if($governanceChanged){Exit-ControlError 28 'postflight' $taskId 'Governance snapshot changed during execution.' $null @{}}
    $postflight=Get-GitSnapshot 'postflight' $contract $root;Write-JsonUtf8Atomic $postflight(Join-Path $taskRoot 'postflight.json');$summary=[ordered]@{schema_version=2;session_id=$sessionId;task_id=$taskId;contract_bytes_sha256=$contractInfo.BytesSha256;contract_normalized_sha256=$contractInfo.NormalizedSha256;governance=$governanceStart;session_started_at_utc=([DateTime]::UtcNow-$clock.Elapsed).ToString('o');session_ended_at_utc=[DateTime]::UtcNow.ToString('o');duration_ms_monotonic=$clock.ElapsedMilliseconds;steps=$results;state_path=ConvertTo-NormalPath $statePath};Write-JsonUtf8Atomic $summary(Join-Path $taskRoot 'task-summary.json');[void](Set-SessionState $statePath $taskId $sessionId 'EVIDENCE_FINALIZED' @{summary_sha256=Get-Sha256(Join-Path $taskRoot 'task-summary.json')});Release-WorktreeLock $lock $sessionId;$lock=$null;Write-Output(Join-Path $taskRoot 'task-summary.json')
} catch {
    if($statePath-and(Test-Path -LiteralPath $statePath)){try{[void](Set-SessionState $statePath $taskId $sessionId 'FAILED' @{error=$_.Exception.Message})}catch{}}
    if($lock){try{Release-WorktreeLock $lock $sessionId}catch{}}
    $message=$_.Exception.Message;$trace=$_.ScriptStackTrace;if($message-like'CONTRACT_CHANGED*'){Exit-ControlError 20 'preflight' $taskId $message $ContractPath @{stack=$trace}}elseif($message-like'STAGING_POLICY_VIOLATION*'){Exit-ControlError 13 'preflight' $taskId $message $null @{stack=$trace}}elseif($message-like'*Governance*'){Exit-ControlError 28 'preflight' $taskId $message $null @{stack=$trace}}else{Exit-ControlError 10 'runner' $taskId $message $null @{stack=$trace}}
}
