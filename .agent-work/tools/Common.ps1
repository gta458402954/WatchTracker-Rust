Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:GovernanceRules = [ordered]@{
    10='BASE_OR_REPOSITORY_MISMATCH'; 11='FORBIDDEN_FILE'; 12='PROTECTED_REGION_CHANGED';
    13='STAGING_POLICY_VIOLATION'; 14='RAW_EVIDENCE_CHANGED'; 15='MANIFEST_SUMMARY_MISMATCH';
    16='RESIDUAL_PROCESS'; 17='EVIDENCE_TIME_ORDER_INVALID'; 18='CHANGE_BUDGET_EXCEEDED';
    19='UNATTRIBUTED_WORKSPACE_CHANGE'; 20='CONTRACT_CHANGED'; 21='ENCODING_OR_EOL_CHANGED';
    22='REQUIRED_FILE_MISSING'; 23='BASELINE_WAIVER_MISMATCH'; 24='INVALID_OR_MISSING_ATTESTATION';
    25='MONITORED_IGNORED_FILE'; 26='CONCURRENT_SESSION'; 27='STALE_SESSION_REQUIRES_RECOVERY';
    28='GOVERNANCE_TOOL_CHANGED'; 29='SENSITIVE_DATA_RISK'; 30='INVALID_STATE_TRANSITION';
    99='INTERNAL_ERROR'
}

function Invoke-GitText {
    param([Parameter(Mandatory)][string[]]$Arguments, [string]$WorkingDirectory=(Get-Location).Path, [hashtable]$Environment)
    $psi=[Diagnostics.ProcessStartInfo]::new(); $psi.FileName='git'
    [void]$psi.ArgumentList.Add('-C'); [void]$psi.ArgumentList.Add($WorkingDirectory)
    foreach($argument in $Arguments){[void]$psi.ArgumentList.Add($argument)}
    $psi.UseShellExecute=$false; $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true; $psi.CreateNoWindow=$true
    if($Environment){foreach($key in $Environment.Keys){if($null-eq$Environment[$key]){[void]$psi.Environment.Remove([string]$key)}else{$psi.Environment[[string]$key]=[string]$Environment[$key]}}}
    $process=[Diagnostics.Process]::Start($psi); $stdoutTask=$process.StandardOutput.ReadToEndAsync(); $stderrTask=$process.StandardError.ReadToEndAsync()
    $process.WaitForExit(); $stdout=$stdoutTask.GetAwaiter().GetResult(); $stderr=$stderrTask.GetAwaiter().GetResult()
    if($process.ExitCode-ne 0){throw "git $($Arguments -join ' ') failed ($($process.ExitCode)): $stderr"}
    return $stdout.TrimEnd("`r","`n")
}

function Get-BytesSha256 {
    param([Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$Bytes)
    return ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes))).ToUpperInvariant()
}
function Get-Sha256 { param([Parameter(Mandatory)][string]$LiteralPath); return Get-BytesSha256 ([IO.File]::ReadAllBytes($LiteralPath)) }
function Get-NormalizedTextSha256 {
    param([Parameter(Mandatory)][string]$LiteralPath)
    $text=[Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($LiteralPath)) -replace "`r`n","`n"
    return Get-BytesSha256 ([Text.UTF8Encoding]::new($false).GetBytes($text))
}
function ConvertTo-NormalPath { param([AllowEmptyString()][AllowNull()][string]$Path); if([string]::IsNullOrEmpty($Path)){return ''}; return ($Path-replace '\\','/').TrimEnd('/') }
function Convert-GlobToRegex { param([Parameter(Mandatory)][string]$Pattern); $e=[Regex]::Escape((ConvertTo-NormalPath $Pattern)); $e=$e-replace '\\\*\\\*','.*'; $e=$e-replace '\\\*','[^/]*'; $e=$e-replace '\\\?','[^/]'; return '^'+$e+'$' }
function Test-PathMatchesAny { param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)]$Patterns); $p=ConvertTo-NormalPath $Path; foreach($pattern in @($Patterns)){if($p-match(Convert-GlobToRegex([string]$pattern))){return $true}}; return $false }

function Write-ControlError {
    param([int]$Code,[string]$Phase,[AllowNull()][string]$TaskId,[string]$Message,[AllowNull()][string]$Path,[hashtable]$Additional)
    $details=[ordered]@{message=$Message}; if($Additional){foreach($key in $Additional.Keys){$details[$key]=$Additional[$key]}}
    $ruleEntry=$script:GovernanceRules.GetEnumerator()|Where-Object{[int]$_.Key-eq$Code}|Select-Object -First 1;$rule=if($ruleEntry){[string]$ruleEntry.Value}else{'INTERNAL_ERROR'}
    $value=[ordered]@{schema_version=1;passed=$false;exit_code=$Code;rule=$rule;phase=$Phase;task_id=$TaskId;path=$Path;details=$details}
    [Console]::Out.WriteLine(($value|ConvertTo-Json -Depth 100 -Compress)); return $value
}
function Exit-ControlError { param([int]$Code,[string]$Phase,[AllowNull()][string]$TaskId,[string]$Message,[AllowNull()][string]$Path,[hashtable]$Additional); [void](Write-ControlError $Code $Phase $TaskId $Message $Path $Additional); exit $Code }

function Test-NoReparsePoint {
    param([Parameter(Mandatory)][string]$LiteralPath,[Parameter(Mandatory)][string]$AllowedRoot)
    $resolved=[IO.Path]::GetFullPath((Resolve-Path -LiteralPath $LiteralPath).Path); $root=[IO.Path]::GetFullPath((Resolve-Path -LiteralPath $AllowedRoot).Path).TrimEnd('\')
    if(-not $resolved.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Contract path is outside the Governance root.'}
    $current=$resolved; while($current.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){$item=Get-Item -LiteralPath $current -Force; if($item.Attributes-band[IO.FileAttributes]::ReparsePoint){throw "Reparse point is forbidden in contract path: $current"}; if($current-eq$root){break}; $current=Split-Path $current -Parent}
    return $resolved
}

function Read-TaskContractSnapshot {
    param([Parameter(Mandatory)][string]$ContractPath,[Parameter(Mandatory)][string]$ExpectedContractBytesSha256,[Parameter(Mandatory)][string]$ExpectedTaskId,[Parameter(Mandatory)][string]$GovernanceRoot)
    $resolved=Test-NoReparsePoint $ContractPath $GovernanceRoot; $bytes=[IO.File]::ReadAllBytes($resolved); $bytesHash=Get-BytesSha256 $bytes
    if($bytesHash-cne$ExpectedContractBytesSha256.ToUpperInvariant()){throw [InvalidOperationException]::new("CONTRACT_CHANGED: expected $ExpectedContractBytesSha256; actual $bytesHash")}
    $decoder=[Text.UTF8Encoding]::new($false,$true); $raw=$decoder.GetString($bytes)
    $schema=Join-Path $GovernanceRoot '.agent-work\schemas\task-contract.schema.json'; if(-not(Test-Path -LiteralPath $schema)){throw 'Task contract schema is missing.'}
    if(-not($raw|Test-Json -SchemaFile $schema -ErrorAction Stop)){throw 'Task contract schema validation failed.'}
    $value=$raw|ConvertFrom-Json -Depth 100; if([string]$value.task_id-cne$ExpectedTaskId){throw "Task ID mismatch: $($value.task_id)"}
    $normalized=Get-BytesSha256 ([Text.UTF8Encoding]::new($false).GetBytes(($raw-replace"`r`n","`n")))
    return [pscustomobject]@{Path=$resolved;Bytes=$bytes;BytesSha256=$bytesHash;NormalizedSha256=$normalized;Value=$value;GovernanceRoot=[IO.Path]::GetFullPath($GovernanceRoot)}
}

function Assert-RepositoryIdentity {
    param([Parameter(Mandatory)]$ContractInfo,[string]$WorkingDirectory=(Get-Location).Path)
    $c=$ContractInfo.Value; $root=ConvertTo-NormalPath(Invoke-GitText @('rev-parse','--show-toplevel') $WorkingDirectory); $expected=ConvertTo-NormalPath([string]$c.repository.expected_worktree)
    if($root-cne$expected){throw "Wrong worktree. Expected $expected; actual $root"}; if((Split-Path $root -Leaf)-cne[string]$c.repository.expected_root_name){throw 'Wrong worktree root name.'}
    $common=ConvertTo-NormalPath(Invoke-GitText @('rev-parse','--path-format=absolute','--git-common-dir') $root); if($common -cne (ConvertTo-NormalPath ([string]$c.repository.expected_common_git_dir))){throw "Common Git directory mismatch: $common"}
    $repoIdPath=Join-Path $root '.agent-work\REPOSITORY_ID'; if(-not(Test-Path -LiteralPath $repoIdPath)){throw 'REPOSITORY_ID is missing.'}; if((Get-Content -LiteralPath $repoIdPath -Raw).Trim()-cne[string]$c.repository.repository_id){throw 'Repository ID mismatch.'}
    $branch=Invoke-GitText @('branch','--show-current') $root; if(-not$c.repository.allow_detached_head-and[string]::IsNullOrWhiteSpace($branch)){throw 'Detached HEAD is forbidden.'}; if($branch-cne[string]$c.repository.expected_branch){throw "Wrong branch: $branch"}
    $head=Invoke-GitText @('rev-parse','HEAD') $root; if($head-cne[string]$c.repository.expected_base){throw "HEAD does not match contract BASE. Expected $($c.repository.expected_base); actual $head"}
    $remote=(Invoke-GitText @('remote','get-url','origin') $root)-replace '://[^/@]+@','://'; if($remote-cne[string]$c.repository.expected_remote){throw "Remote mismatch: $remote"}; return $root
}

function Get-GovernanceToolSnapshot {
    param([Parameter(Mandatory)]$ContractInfo)
    $c=$ContractInfo.Value; $root=[IO.Path]::GetFullPath([string]$c.governance.root); $cleanIndex=@{GIT_INDEX_FILE=$null}; $head=Invoke-GitText @('rev-parse','HEAD') $root $cleanIndex; $status=Invoke-GitText @('status','--porcelain=v2','--untracked-files=all') $root $cleanIndex
    $contractRelative=ConvertTo-NormalPath([IO.Path]::GetRelativePath($root,$ContractInfo.Path));if(-not$contractRelative.StartsWith('../')){$statusLines=@($status-split"`n"|Where-Object{$_-and($_-notmatch("\s"+[regex]::Escape($contractRelative)+"$"))});$status=$statusLines-join"`n"}
    if(-not[bool]$c.governance.bootstrap){if($head-cne[string]$c.governance.expected_commit){throw 'Governance commit mismatch.'}; if([bool]$c.governance.require_clean-and$Status){throw 'Governance worktree is not clean.'}}
    $hashes=[ordered]@{}; foreach($property in $c.governance.tool_sha256.psobject.Properties){$path=Join-Path $root ($property.Name-replace'/','\'); if(-not(Test-Path -LiteralPath $path)){throw "Governance tool missing: $($property.Name)"}; $actual=Get-Sha256 $path; if($actual-cne[string]$property.Value){throw "Governance tool hash mismatch: $($property.Name)"}; $hashes[$property.Name]=$actual}
    return [ordered]@{root=ConvertTo-NormalPath $root;head=$head;status=$status;tool_sha256=$hashes}
}

function Get-WorkspaceChangePaths { param([string]$Root=(Get-Location).Path); $paths=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal); foreach($args in @(@('diff','--name-only'),@('diff','--cached','--name-only'),@('ls-files','--others','--exclude-standard'))){foreach($line in((Invoke-GitText $args $Root)-split"`n")){if($line){[void]$paths.Add((ConvertTo-NormalPath $line.Trim()))}}}; return @($paths|Sort-Object) }
function Get-StagedPaths { param([string]$Root=(Get-Location).Path,[hashtable]$Environment); $text=Invoke-GitText @('diff','--cached','--name-only') $Root $Environment; if(-not$text){return @()}; return @($text-split"`n"|ForEach-Object{ConvertTo-NormalPath $_.Trim()}|Where-Object{$_}) }
function Get-FileFingerprint { param([Parameter(Mandatory)][string]$LiteralPath); $bytes=[IO.File]::ReadAllBytes($LiteralPath); $bom=if($bytes.Length-ge3-and$bytes[0]-eq0xEF-and$bytes[1]-eq0xBB-and$bytes[2]-eq0xBF){'UTF8-BOM'}else{'NONE'}; $text=[Text.Encoding]::UTF8.GetString($bytes); $crlf=([regex]::Matches($text,"`r`n")).Count; $lf=([regex]::Matches($text,"(?<!`r)`n")).Count; $eol=if($crlf-gt0-and$lf-eq0){'CRLF'}elseif($lf-gt0-and$crlf-eq0){'LF'}elseif($lf-eq0-and$crlf-eq0){'NONE'}else{'MIXED'}; return [ordered]@{sha256=Get-BytesSha256 $bytes;size=$bytes.Length;bom=$bom;line_endings=$eol} }
function Get-ProtectedRegionText { param([string]$Text,[string]$Begin,[string]$End); if(([regex]::Matches($Text,[regex]::Escape($Begin))).Count-ne1-or([regex]::Matches($Text,[regex]::Escape($End))).Count-ne1){throw 'Protected markers must occur exactly once.'}; $start=$Text.IndexOf($Begin,[StringComparison]::Ordinal); $finish=$Text.IndexOf($End,$start+$Begin.Length,[StringComparison]::Ordinal); if($finish-lt$start){throw 'Protected markers out of order.'}; return ($Text.Substring($start,($finish+$End.Length)-$start)-replace"`r`n","`n") }

function Write-JsonUtf8Atomic {
    param([Parameter(Mandatory)]$Value,[Parameter(Mandatory)][string]$LiteralPath,[int]$Depth=100)
    $parent=Split-Path $LiteralPath -Parent; if($parent){New-Item -ItemType Directory -Force -Path $parent|Out-Null}; $temp=Join-Path $parent ('.'+[IO.Path]::GetFileName($LiteralPath)+'.'+[guid]::NewGuid().ToString('N')+'.tmp'); $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth $Depth)+"`n")
    try{$stream=[IO.FileStream]::new($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None); try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}; if(Test-Path -LiteralPath $LiteralPath){[IO.File]::Move($temp,$LiteralPath,$true)}else{[IO.File]::Move($temp,$LiteralPath)}; $null=Get-Content -LiteralPath $LiteralPath -Raw|ConvertFrom-Json -Depth 100}finally{if(Test-Path -LiteralPath $temp){Remove-Item -LiteralPath $temp -Force}}
}
function Write-JsonUtf8 { param($Value,[string]$LiteralPath,[int]$Depth=100); Write-JsonUtf8Atomic $Value $LiteralPath $Depth }

function Set-SessionState {
    param([string]$StatePath,[string]$TaskId,[string]$SessionId,[string]$NewState,[hashtable]$Details)
    $allowed=@{CREATED=@('PREFLIGHT_PASSED','FAILED','INTERRUPTED');PREFLIGHT_PASSED=@('RUNNING','FAILED','INTERRUPTED');RUNNING=@('EVIDENCE_FINALIZED','FAILED','INTERRUPTED');EVIDENCE_FINALIZED=@('TEMP_INDEX_VALIDATED','FAILED','INTERRUPTED');TEMP_INDEX_VALIDATED=@('REAL_INDEX_STAGED','FAILED','INTERRUPTED');REAL_INDEX_STAGED=@('COMMIT_CREATED','FAILED','INTERRUPTED');COMMIT_CREATED=@('RECEIPT_CREATED','COMMIT_CREATED_RECEIPT_FAILED','INTERRUPTED');RECEIPT_CREATED=@('VERIFIED','FAILED','INTERRUPTED');VERIFIED=@();FAILED=@();INTERRUPTED=@();COMMIT_CREATED_RECEIPT_FAILED=@()}
    $old=$null;$sequence=1;if(Test-Path -LiteralPath $StatePath){$current=Get-Content -LiteralPath $StatePath -Raw|ConvertFrom-Json -Depth 20;$old=[string]$current.state;$sequence=[int]$current.sequence+1;if($NewState-notin@($allowed[$old])){throw "INVALID_STATE_TRANSITION: $old -> $NewState"}}
    $stateDetails=if($Details){$Details}else{@{}}
    $value=[ordered]@{schema_version=1;task_id=$TaskId;session_id=$SessionId;state=$NewState;previous_state=$old;sequence=$sequence;updated_at_utc=[DateTime]::UtcNow.ToString('o');details=$stateDetails}; Write-JsonUtf8Atomic $value $StatePath; return $value
}

function Acquire-WorktreeLock {
    param([string]$CommonGitDir,[string]$RepositoryId,[string]$Worktree,[string]$TaskId,[string]$SessionId)
    $worktreeId=Get-BytesSha256([Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-NormalPath $Worktree).ToLowerInvariant())); $dir=Join-Path $CommonGitDir "codex-agent-locks\$RepositoryId"; New-Item -ItemType Directory -Force -Path $dir|Out-Null; $path=Join-Path $dir "$worktreeId.lock"
    $self=Get-CimInstance Win32_Process -Filter "ProcessId=$PID"; $selfProcess=Get-Process -Id $PID; $value=[ordered]@{schema_version=1;repository_id=$RepositoryId;worktree=ConvertTo-NormalPath $Worktree;task_id=$TaskId;session_id=$SessionId;pid=$PID;parent_pid=[int]$self.ParentProcessId;creation_time_utc=$selfProcess.StartTime.ToUniversalTime().ToString('o');creation_time_filetime_utc=$selfProcess.StartTime.ToUniversalTime().ToFileTimeUtc();command_line=[string]$self.CommandLine;created_at_utc=[DateTime]::UtcNow.ToString('o')}; $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($value|ConvertTo-Json -Depth 20)+"`n")
    try {
        $stream=[IO.FileStream]::new($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
        try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
        return [pscustomobject]@{Path=$path;Value=$value}
    } catch [IO.IOException] {
        try{$existing=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json;$proc=Get-Process -Id ([int]$existing.pid) -ErrorAction SilentlyContinue;$active=$false;if($proc){$active=$proc.StartTime.ToUniversalTime().ToFileTimeUtc()-eq[long]$existing.creation_time_filetime_utc}}catch{$active=$false}
        if($active){throw 'CONCURRENT_SESSION'}else{throw 'STALE_SESSION_REQUIRES_RECOVERY'}
    }
}
function Release-WorktreeLock { param($Lock,[string]$SessionId); if(-not$Lock){return}; $current=Get-Content -LiteralPath $Lock.Path -Raw|ConvertFrom-Json;if([string]$current.session_id-cne$SessionId){throw 'Lock ownership changed.'};Remove-Item -LiteralPath $Lock.Path -Force }

function Protect-SensitiveText {
    param([AllowNull()][string]$Text,$EvidencePolicy)
    if($null-eq$Text){return ''}; $result=$Text; foreach($name in @($EvidencePolicy.sensitive_names)){$value=[Environment]::GetEnvironmentVariable([string]$name);if(-not[string]::IsNullOrEmpty($value)){$result=$result.Replace($value,"<REDACTED:$name>")}}; return $result
}
