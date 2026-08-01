param(
    [Parameter(Mandatory)][string]$ContractPath,
    [Parameter(Mandatory)][string]$ExpectedContractBytesSha256,
    [Parameter(Mandatory)][string]$ExpectedTaskId,
    [Parameter(Mandatory)][string]$EvidenceManifest,
    [string]$Commit='HEAD'
)
. (Join-Path $PSScriptRoot 'Common.ps1')
$governanceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'));$taskId=$ExpectedTaskId
function Reject([string]$Message,[string]$Path=$null,[hashtable]$More=@{}){Exit-ControlError 24 'attestation' $taskId $Message $Path $More}
try {
    $info=Read-TaskContractSnapshot $ContractPath $ExpectedContractBytesSha256 $ExpectedTaskId $governanceRoot;$root=ConvertTo-NormalPath(Invoke-GitText @('rev-parse','--show-toplevel'));$resolved=Invoke-GitText @('rev-parse',$Commit) $root;$message=Invoke-GitText @('show','-s','--format=%B',$resolved) $root
    $trailers=[ordered]@{};foreach($name in @('Task-ID','Contract-Bytes-SHA256','Contract-Normalized-SHA256','Implementation-Base','Runner-Session-ID','Evidence-Manifest-SHA256','Governance-Commit','Safe-Commit-Version','Scope-Check')){if($message-notmatch("(?m)^"+[regex]::Escape($name)+":\s*(.+?)\s*$")){Reject "Missing commit trailer: $name"};$trailers[$name]=$Matches[1]}
    if($trailers['Task-ID']-cne$taskId-or$trailers['Contract-Bytes-SHA256']-cne$info.BytesSha256-or$trailers['Contract-Normalized-SHA256']-cne$info.NormalizedSha256-or$trailers['Safe-Commit-Version']-cne'2'-or$trailers['Scope-Check']-cne'PASS'){Reject 'Commit trailers conflict with the authorized contract.'}
    $parent=Invoke-GitText @('rev-parse',"$resolved^") $root;$tree=Invoke-GitText @('rev-parse',"$resolved^{tree}") $root;if($parent-cne$trailers['Implementation-Base']){Reject 'Commit parent differs from Implementation-Base.'}
    $evidenceHash=Get-Sha256 $EvidenceManifest;if($evidenceHash-cne$trailers['Evidence-Manifest-SHA256']){Reject 'Evidence manifest Hash differs from trailer.' $EvidenceManifest}
    $common=Invoke-GitText @('rev-parse','--path-format=absolute','--git-common-dir') $root;$receiptPath=Join-Path $common("codex-attestations\$taskId\$resolved.json");if(-not(Test-Path -LiteralPath $receiptPath)){Reject 'Safe Commit receipt is missing.' $receiptPath};$receipt=Get-Content -LiteralPath $receiptPath -Raw|ConvertFrom-Json -Depth 100
    if([string]$receipt.commit-cne$resolved-or[string]$receipt.parent-cne$parent-or[string]$receipt.tree-cne$tree-or[string]$receipt.implementation_base-cne$parent-or[string]$receipt.task_id-cne$taskId-or[string]$receipt.contract_bytes_sha256-cne$info.BytesSha256-or[string]$receipt.evidence_manifest_sha256-cne$evidenceHash-or[string]$receipt.runner_session_id-cne$trailers['Runner-Session-ID']-or[int]$receipt.safe_commit_version-ne2-or-not[bool]$receipt.commit_trailers_verified){Reject 'Receipt fields are inconsistent with commit, contract, or evidence.' $receiptPath}
    $actual=@((Invoke-GitText @('diff-tree','--no-commit-id','--name-only','-r',$resolved) $root)-split"`n"|Where-Object{$_}|Sort-Object);if(($actual-join"`n")-cne(@($receipt.committed_files|Sort-Object)-join"`n")){Reject 'Receipt file set differs from commit.' $receiptPath}
    foreach($property in $receipt.tool_sha256.psobject.Properties){$tool=Join-Path $governanceRoot($property.Name-replace'/','\');if(-not(Test-Path -LiteralPath $tool)-or(Get-Sha256 $tool)-cne[string]$property.Value){Reject 'Governance tool Hash differs from receipt.' $property.Name}}
    $success=[ordered]@{schema_version=1;passed=$true;exit_code=0;rule='PASS';phase='attestation';task_id=$taskId;commit=$resolved;contract_bytes_sha256=$info.BytesSha256;evidence_manifest_sha256=$evidenceHash;receipt=$receiptPath};Write-Output($success|ConvertTo-Json -Depth 20 -Compress)
} catch {if($_.Exception.Message-like'CONTRACT_CHANGED*'){Exit-ControlError 20 'attestation' $taskId $_.Exception.Message $ContractPath @{}};Reject $_.Exception.Message}
