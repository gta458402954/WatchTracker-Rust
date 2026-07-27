param(
    [Parameter(Mandatory)][string]$ContractPath,
    [Parameter(Mandatory)][string]$ExpectedContractBytesSha256,
    [Parameter(Mandatory)][string]$ExpectedTaskId,
    [string]$PreflightManifest,
    [string]$EvidenceManifest,
    [string]$WaiverDiagnosticsManifest
)
. (Join-Path $PSScriptRoot 'Common.ps1')
$governanceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'));$taskId=$ExpectedTaskId
function Reject([int]$Code,[string]$Message,[string]$Path=$null,[hashtable]$More=@{}){Exit-ControlError $Code 'precommit' $taskId $Message $Path $More}
try {
    $info=Read-TaskContractSnapshot $ContractPath $ExpectedContractBytesSha256 $ExpectedTaskId $governanceRoot;$root=Assert-RepositoryIdentity $info;$contract=$info.Value;$null=Get-GovernanceToolSnapshot $info
    $workspace=@(Get-WorkspaceChangePaths $root)
    foreach($path in $workspace){
        if(Test-PathMatchesAny $path $contract.workspace_policy.forbidden_modified_files){Reject 11 "Forbidden workspace file: $path" $path}
        if(Test-PathMatchesAny $path @($contract.workspace_policy.conditional_files|ForEach-Object{$_.path})){Reject 11 "Conditional file requires a Codex-reissued contract: $path" $path}
        if(-not((Test-PathMatchesAny $path $contract.workspace_policy.allowed_modified_files)-or(Test-PathMatchesAny $path $contract.workspace_policy.allowed_generated_paths))){Reject 19 "Unattributed workspace change: $path" $path}
    }
    $ignored=Invoke-GitText @('status','--porcelain=v2','--ignored=matching','--untracked-files=all') $root
    foreach($line in($ignored-split"`n")){if($line-notmatch'^!\s+(.+)$'){continue};$path=ConvertTo-NormalPath $Matches[1].TrimEnd('/');$patterns=@($contract.workspace_policy.monitored_roots|ForEach-Object{(ConvertTo-NormalPath $_)+'/**'});if((Test-PathMatchesAny $path $patterns)-and-not(Test-PathMatchesAny $path $contract.workspace_policy.allowed_generated_paths)){Reject 25 "Monitored ignored path is not authorized: $path" $path}}
    $staged=@(Get-StagedPaths $root)
    foreach($path in $staged){if(-not(Test-PathMatchesAny $path $contract.commit_policy.allowed_staged_files)){Reject 13 "Staged file outside allowlist: $path" $path};if(Test-PathMatchesAny $path $contract.commit_policy.forbidden_staged_files){Reject 11 "Forbidden staged file: $path" $path}}
    foreach($required in @($contract.commit_policy.required_staged_files)){if(-not@($staged|Where-Object{Test-PathMatchesAny $_ @($required)}).Count){Reject 22 "Required staged path missing: $required" $required}}
    foreach($protected in @($contract.commit_policy.protected_files)){$changed=Invoke-GitText @('diff','--name-only',$contract.repository.expected_base,'--',[string]$protected) $root;if($changed){Reject 12 "Reviewer-owned file changed: $protected" $protected}}
    foreach($region in @($contract.commit_policy.protected_regions)){$baseText=(Invoke-GitText @('show',"$($contract.repository.expected_base):$($region.path)") $root);$currentPath=Join-Path $root($region.path-replace'/','\');if(-not(Test-Path -LiteralPath $currentPath)){Reject 12 'Protected-region file missing.' $region.path};$currentText=Get-Content -LiteralPath $currentPath -Raw -Encoding utf8;if((Get-ProtectedRegionText $baseText $region.begin_marker $region.end_marker)-cne(Get-ProtectedRegionText $currentText $region.begin_marker $region.end_marker)){Reject 12 'Protected region changed.' $region.path}}
    if($staged.Count-gt[int]$contract.change_budget.max_files){Reject 18 'File-count budget exceeded.'}
    $insertions=0;$deletions=0;$binary=0;$numstat=Invoke-GitText @('diff','--cached','--numstat') $root
    foreach($line in($numstat-split"`n")){if(-not$line){continue};$parts=$line-split"`t";if($parts[0]-eq'-'-or$parts[1]-eq'-'){$binary++;continue};$insertions+=[int]$parts[0];$deletions+=[int]$parts[1]}
    if($insertions-gt[int]$contract.change_budget.max_insertions-or$deletions-gt[int]$contract.change_budget.max_deletions-or$binary-gt[int]$contract.change_budget.max_binary_changes){Reject 18 "Change budget exceeded: +$insertions -$deletions binary=$binary"}
    if($PreflightManifest){$preflight=Get-Content -LiteralPath $PreflightManifest -Raw|ConvertFrom-Json -Depth 100;foreach($entry in @($preflight.files)){if($null-eq$entry.fingerprint-or$entry.path-notin$staged){continue};$current=Get-FileFingerprint(Join-Path $root($entry.path-replace'/','\'));if($contract.change_budget.preserve_encoding-and$current.bom-cne$entry.fingerprint.bom){Reject 21 'BOM changed.' $entry.path};if($contract.change_budget.preserve_line_endings-and$current.line_endings-cne$entry.fingerprint.line_endings){Reject 21 'Line endings changed.' $entry.path}}}
    foreach($phrase in @($contract.forbidden_phrases)){foreach($path in @($staged|Where-Object{Test-PathMatchesAny $_ $contract.commit_policy.executor_summary_files})){$added=Invoke-GitText @('diff','--cached','-U0','--',$path) $root;if((($added-split"`n")|Where-Object{$_-match'^\+(?!\+\+)'})-match[regex]::Escape([string]$phrase)){Reject 15 "Forbidden executor phrase: $phrase" $path}}}
    if($EvidenceManifest){$manifest=Get-Content -LiteralPath $EvidenceManifest -Raw|ConvertFrom-Json -Depth 100;if([string]$manifest.contract_bytes_sha256-cne$info.BytesSha256){Reject 14 'Evidence manifest contract Hash mismatch.' $EvidenceManifest};foreach($entry in @($manifest.files)){$full=Join-Path $root($entry.path-replace'/','\');if(-not(Test-Path -LiteralPath $full)){Reject 14 'Evidence file missing.' $entry.path};if((Get-Sha256 $full)-cne[string]$entry.sha256){Reject 14 'Evidence Hash mismatch.' $entry.path};if($entry.producer_ended_at_utc-and$entry.hashed_at_utc-and[DateTime]$entry.hashed_at_utc-le[DateTime]$entry.producer_ended_at_utc){Reject 17 'Evidence Hash predates producer completion.' $entry.path}}}
    if(@($contract.waivers).Count){if(-not$WaiverDiagnosticsManifest){Reject 23 'Waiver diagnostics manifest is required.'};$diagnostics=Get-Content -LiteralPath $WaiverDiagnosticsManifest -Raw|ConvertFrom-Json -Depth 100;foreach($waiver in @($contract.waivers)){$record=@($diagnostics.waivers|Where-Object{$_.waiver_id-ceq$waiver.waiver_id})|Select-Object -First 1;if(-not$record){Reject 23 "Waiver record missing: $($waiver.waiver_id)"};$new=@($record.current_fingerprints|Where-Object{$_-notin@($waiver.diagnostic_fingerprints)});if($new.Count){Reject 23 'New diagnostics are not covered by baseline waiver.' $WaiverDiagnosticsManifest @{waiver_id=$waiver.waiver_id;new_diagnostics=$new}};foreach($modified in @($record.modified_paths)){if($modified-in@($record.current_paths)){Reject 23 'Modified path still has waived diagnostics.' $modified @{waiver_id=$waiver.waiver_id}}}}}
    Invoke-GitText @('diff','--cached','--check') $root|Out-Null
    $success=[ordered]@{schema_version=1;passed=$true;exit_code=0;rule='PASS';phase='precommit';task_id=$taskId;contract_bytes_sha256=$info.BytesSha256;staged_files=$staged;insertions=$insertions;deletions=$deletions;binary_changes=$binary};Write-Output($success|ConvertTo-Json -Depth 20 -Compress);exit 0
} catch {
    $m=$_.Exception.Message;$detail=@{stack=$_.ScriptStackTrace};if($m-like'CONTRACT_CHANGED*'){Reject 20 $m $ContractPath $detail};if($m-like'*Repository*'-or$m-like'Wrong *'-or$m-like'*BASE*'-or$m-like'*worktree*'){Reject 10 $m $null $detail};if($m-like'*Governance*'){Reject 28 $m $null $detail};Reject 99 $m $null $detail
}
