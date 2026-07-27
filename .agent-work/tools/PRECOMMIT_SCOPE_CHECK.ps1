param(
    [Parameter(Mandatory)][string]$ContractPath,
    [string]$ExpectedContractSha256,
    [string]$PreflightManifest,
    [string]$EvidenceManifest
)

. (Join-Path $PSScriptRoot 'Common.ps1')

function Stop-Check([int]$Code, [string]$Message) {
    [Console]::Error.WriteLine("SCOPE_CHECK[$Code]: $Message")
    exit $Code
}

try {
    $contractInfo = Read-TaskContract $ContractPath
    $root = Assert-RepositoryIdentity $contractInfo
    $contract = $contractInfo.Value
    if ($ExpectedContractSha256 -and $contractInfo.Sha256 -cne $ExpectedContractSha256.ToUpperInvariant()) { Stop-Check 10 'Contract hash differs from task start.' }

    $workspacePaths = @(Get-WorkspaceChangePaths $root)
    foreach ($path in $workspacePaths) {
        $allowed = (Test-PathMatchesAny $path $contract.workspace_policy.allowed_modified_files) -or (Test-PathMatchesAny $path $contract.workspace_policy.allowed_generated_paths)
        if (-not $allowed) { Stop-Check 19 "Unattributed workspace change: $path" }
        if (Test-PathMatchesAny $path $contract.workspace_policy.forbidden_modified_files) { Stop-Check 11 "Forbidden workspace file: $path" }
    }
    $ignoredText = Invoke-GitText @('status','--porcelain=v2','--ignored=matching','--untracked-files=all') $root
    foreach ($line in ($ignoredText -split "`n")) {
        if ($line -notmatch '^!\s+(.+)$') { continue }
        $ignoredPath = ConvertTo-NormalPath $Matches[1].TrimEnd('/')
        $monitored = Test-PathMatchesAny $ignoredPath @($contract.workspace_policy.monitored_roots | ForEach-Object { (ConvertTo-NormalPath $_) + '/**' })
        if ($monitored -and -not (Test-PathMatchesAny $ignoredPath $contract.workspace_policy.allowed_generated_paths)) { Stop-Check 19 "Ignored file/path is not authorized: $ignoredPath" }
    }

    $staged = @(Get-StagedPaths $root)
    foreach ($path in $staged) {
        if (-not (Test-PathMatchesAny $path $contract.commit_policy.allowed_staged_files)) { Stop-Check 13 "Staged file outside allowlist: $path" }
        if (Test-PathMatchesAny $path $contract.commit_policy.forbidden_staged_files) { Stop-Check 11 "Forbidden staged file: $path" }
    }
    foreach ($required in @($contract.commit_policy.required_staged_files)) {
        if (-not (@($staged | Where-Object { Test-PathMatchesAny $_ @($required) }).Count)) { Stop-Check 13 "Required staged path missing: $required" }
    }

    foreach ($protected in @($contract.commit_policy.protected_files)) {
        $changed = & git -C $root diff --name-only $contract.repository.expected_base -- $protected
        if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect protected file.' }
        if ($changed) { Stop-Check 12 "Reviewer-owned file changed: $protected" }
    }
    foreach ($region in @($contract.commit_policy.protected_regions)) {
        $baseText = (& git -C $root show "$($contract.repository.expected_base):$($region.path)" 2>$null) -join "`n"
        if ($LASTEXITCODE -ne 0) { Stop-Check 12 "Unable to read protected region from BASE: $($region.path)" }
        $currentPath = Join-Path $root ($region.path -replace '/', '\')
        if (-not (Test-Path -LiteralPath $currentPath)) { Stop-Check 12 "Protected-region file missing: $($region.path)" }
        $currentText = Get-Content -LiteralPath $currentPath -Raw -Encoding utf8
        $baseRegion = Get-ProtectedRegionText $baseText $region.begin_marker $region.end_marker
        $currentRegion = Get-ProtectedRegionText $currentText $region.begin_marker $region.end_marker
        if ($baseRegion -cne $currentRegion) { Stop-Check 12 "Protected region changed: $($region.path)" }
    }

    if ($staged.Count -gt [int]$contract.change_budget.max_files) { Stop-Check 18 'File-count budget exceeded.' }
    $insertions = 0; $deletions = 0; $binary = 0
    $numstat = (& git -C $root diff --cached --numstat) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'Unable to calculate staged numstat.' }
    foreach ($line in ($numstat -split "`n")) {
        if (-not $line) { continue }
        $parts = $line -split "`t"
        if ($parts[0] -eq '-' -or $parts[1] -eq '-') { $binary++; continue }
        $insertions += [int]$parts[0]; $deletions += [int]$parts[1]
    }
    if ($insertions -gt [int]$contract.change_budget.max_insertions -or $deletions -gt [int]$contract.change_budget.max_deletions -or $binary -gt [int]$contract.change_budget.max_binary_changes) { Stop-Check 18 "Change budget exceeded: +$insertions -$deletions binary=$binary" }

    if ($PreflightManifest) {
        $preflight = Get-Content -LiteralPath $PreflightManifest -Raw | ConvertFrom-Json -Depth 100
        foreach ($entry in @($preflight.files)) {
            if ($null -eq $entry.fingerprint -or $entry.path -notin $staged) { continue }
            $current = Get-FileFingerprint (Join-Path $root ($entry.path -replace '/', '\'))
            if ($contract.change_budget.preserve_encoding -and $current.bom -cne $entry.fingerprint.bom) { Stop-Check 18 "BOM changed: $($entry.path)" }
            if ($contract.change_budget.preserve_line_endings -and $current.line_endings -cne $entry.fingerprint.line_endings) { Stop-Check 18 "Line endings changed: $($entry.path)" }
        }
    }

    foreach ($phrase in @($contract.forbidden_phrases)) {
        foreach ($path in @($staged | Where-Object { Test-PathMatchesAny $_ $contract.commit_policy.executor_summary_files })) {
            $addedText = (& git -C $root diff --cached -U0 -- $path | Where-Object { $_ -match '^\+(?!\+\+)' }) -join "`n"
            if ($addedText -match [regex]::Escape([string]$phrase)) { Stop-Check 15 "Forbidden executor phrase '$phrase' in added lines of $path" }
        }
    }

    if ($EvidenceManifest) {
        $manifest = Get-Content -LiteralPath $EvidenceManifest -Raw | ConvertFrom-Json -Depth 100
        if ([string]$manifest.contract_sha256 -cne $contractInfo.Sha256) { Stop-Check 14 'Evidence manifest contract hash mismatch.' }
        foreach ($entry in @($manifest.files)) {
            $full = Join-Path $root ($entry.path -replace '/', '\')
            if (-not (Test-Path -LiteralPath $full)) { Stop-Check 14 "Evidence file missing: $($entry.path)" }
            if ((Get-Sha256 $full) -cne [string]$entry.sha256) { Stop-Check 14 "Evidence hash mismatch: $($entry.path)" }
        }
    }

    & git -C $root diff --cached --check
    if ($LASTEXITCODE -ne 0) { Stop-Check 15 'git diff --cached --check failed.' }
    Write-Output ([ordered]@{ result='PASS'; contract_sha256=$contractInfo.Sha256; staged_files=$staged; insertions=$insertions; deletions=$deletions; binary_changes=$binary } | ConvertTo-Json -Depth 10)
    exit 0
} catch {
    Stop-Check 99 $_.Exception.Message
}
