param(
    [Parameter(Mandatory)][string]$ContractPath,
    [Parameter(Mandatory)][string]$Message,
    [string]$PreflightManifest,
    [string]$EvidenceManifest
)

. (Join-Path $PSScriptRoot 'Common.ps1')
$contractInfo = Read-TaskContract $ContractPath
$root = Assert-RepositoryIdentity $contractInfo
$contract = $contractInfo.Value
$initialStaged = @(Get-StagedPaths $root)
if ($initialStaged.Count -ne 0) { throw "SAFE_COMMIT refuses a non-empty initial index: $($initialStaged -join ', ')" }

$changes = @(Get-WorkspaceChangePaths $root)
$selected = @()
foreach ($path in $changes) {
    if (Test-PathMatchesAny $path $contract.commit_policy.allowed_staged_files) { $selected += $path }
}
foreach ($required in @($contract.commit_policy.required_staged_files)) {
    if (-not (@($selected | Where-Object { Test-PathMatchesAny $_ @($required) }).Count)) { throw "Required commit path is absent: $required" }
}
if ($selected.Count -eq 0) { throw 'No authorized files are available to commit.' }
foreach ($path in $selected) { & git -C $root add -- $path; if ($LASTEXITCODE -ne 0) { throw "Unable to stage $path" } }

$checker = Join-Path $PSScriptRoot 'PRECOMMIT_SCOPE_CHECK.ps1'
$commitCreated = $false
try {
    $checkerArgs = @('-NoProfile','-File',$checker,'-ContractPath',$contractInfo.Path,'-ExpectedContractSha256',$contractInfo.Sha256)
    if ($PreflightManifest) { $checkerArgs += @('-PreflightManifest',$PreflightManifest) }
    if ($EvidenceManifest) { $checkerArgs += @('-EvidenceManifest',$EvidenceManifest) }
    & pwsh @checkerArgs
    if ($LASTEXITCODE -ne 0) { throw "Scope checker rejected the commit with exit $LASTEXITCODE" }

    $staged = @(Get-StagedPaths $root)
    $body = "$Message`n`nContract-SHA256: $($contractInfo.Sha256)`nSafe-Commit-Version: 1`nScope-Check: PASS"
    $oldContractEnv = [Environment]::GetEnvironmentVariable('CODEX_TASK_CONTRACT','Process')
    $oldHashEnv = [Environment]::GetEnvironmentVariable('CODEX_CONTRACT_SHA256','Process')
    try {
        [Environment]::SetEnvironmentVariable('CODEX_TASK_CONTRACT',$contractInfo.Path,'Process')
        [Environment]::SetEnvironmentVariable('CODEX_CONTRACT_SHA256',$contractInfo.Sha256,'Process')
        & git -C $root commit -m $body
        if ($LASTEXITCODE -ne 0) { throw 'git commit failed.' }
        $commitCreated = $true
    } finally {
        [Environment]::SetEnvironmentVariable('CODEX_TASK_CONTRACT',$oldContractEnv,'Process')
        [Environment]::SetEnvironmentVariable('CODEX_CONTRACT_SHA256',$oldHashEnv,'Process')
    }
} catch {
    if (-not $commitCreated) {
        foreach ($path in $selected) { & git -C $root restore --staged -- $path 2>$null }
    }
    throw
}
$commit = Invoke-GitText @('rev-parse','HEAD') $root
$parent = Invoke-GitText @('rev-parse','HEAD^') $root
$tree = Invoke-GitText @('rev-parse','HEAD^{tree}') $root
$actualText = Invoke-GitText @('diff-tree','--no-commit-id','--name-only','-r','HEAD') $root
$actual = if ($actualText) { @($actualText -split "`n" | Sort-Object) } else { @() }
$expected = @($staged | Sort-Object)
if (($actual -join "`n") -cne ($expected -join "`n")) { throw "Committed file set differs from staged set.`nExpected: $($expected -join ', ')`nActual: $($actual -join ', ')" }

$gitPath = Invoke-GitText @('rev-parse','--git-path','codex-attestations') $root
if (-not [IO.Path]::IsPathRooted($gitPath)) { $gitPath = Join-Path $root $gitPath }
$receiptPath = Join-Path $gitPath ("$commit.json")
$receipt = [ordered]@{
    schema_version = 1
    commit = $commit
    parent = $parent
    tree = $tree
    contract_path = ConvertTo-NormalPath ([IO.Path]::GetRelativePath($root, $contractInfo.Path))
    contract_sha256 = $contractInfo.Sha256
    scope_check_exit = 0
    safe_commit_version = 1
    staged_files = $expected
    created_at_utc = [DateTime]::UtcNow.ToString('o')
}
Write-JsonUtf8 $receipt $receiptPath
Write-Output $receiptPath
