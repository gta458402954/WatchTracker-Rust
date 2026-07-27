param(
    [string]$OutputPath = '.agent-work/evidence/governance/TASK-G-001-red-team.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$fixture = Join-Path $tempBase ("watchtracker-governance-redteam-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$results = @()

function Add-Result([string]$Name, [bool]$Passed, [string]$Details) {
    $script:results += [ordered]@{ name=$Name; passed=$Passed; details=$Details }
}

function Invoke-Child([string]$Script, [string[]]$Arguments) {
    Push-Location $script:fixture
    try {
        $output = & pwsh -NoProfile -File $Script @Arguments 2>&1
        return [pscustomobject]@{ ExitCode=$LASTEXITCODE; Output=($output -join "`n") }
    } finally {
        Pop-Location
    }
}

try {
    & git -C $fixture init -b test | Out-Null
    & git -C $fixture config user.email 'governance-test@example.invalid'
    & git -C $fixture config user.name 'Governance Red Team'
    & git -C $fixture remote add origin 'https://example.invalid/repo.git'
    New-Item -ItemType Directory -Force -Path (Join-Path $fixture '.agent-work\tools'), (Join-Path $fixture '.agent-work\schemas'), (Join-Path $fixture '.agent-work\tasks') | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRoot '.agent-work\tools\Common.ps1') -Destination (Join-Path $fixture '.agent-work\tools\Common.ps1')
    Copy-Item -LiteralPath (Join-Path $sourceRoot '.agent-work\tools\ANTIGRAVITY_TASK_RUNNER.ps1') -Destination (Join-Path $fixture '.agent-work\tools\ANTIGRAVITY_TASK_RUNNER.ps1')
    Copy-Item -LiteralPath (Join-Path $sourceRoot '.agent-work\tools\PRECOMMIT_SCOPE_CHECK.ps1') -Destination (Join-Path $fixture '.agent-work\tools\PRECOMMIT_SCOPE_CHECK.ps1')
    Copy-Item -LiteralPath (Join-Path $sourceRoot '.agent-work\tools\EVIDENCE_MANIFEST.ps1') -Destination (Join-Path $fixture '.agent-work\tools\EVIDENCE_MANIFEST.ps1')
    Copy-Item -LiteralPath (Join-Path $sourceRoot '.agent-work\tools\SAFE_COMMIT.ps1') -Destination (Join-Path $fixture '.agent-work\tools\SAFE_COMMIT.ps1')
    Copy-Item -LiteralPath (Join-Path $sourceRoot '.agent-work\tools\VERIFY_ATTESTATION.ps1') -Destination (Join-Path $fixture '.agent-work\tools\VERIFY_ATTESTATION.ps1')
    Copy-Item -LiteralPath (Join-Path $sourceRoot '.agent-work\schemas\task-contract.schema.json') -Destination (Join-Path $fixture '.agent-work\schemas\task-contract.schema.json')
    New-Item -ItemType Directory -Force -Path (Join-Path $fixture '.githooks') | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRoot '.githooks\pre-commit') -Destination (Join-Path $fixture '.githooks\pre-commit')
    [IO.File]::WriteAllText((Join-Path $fixture '.agent-work\REPOSITORY_ID'), "11111111-1111-4111-8111-111111111111`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixture 'allowed.txt'), "original`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixture 'protected.md'), "<!-- BEGIN OWNER:CODEX TEST -->`nprotected`n<!-- END OWNER:CODEX TEST -->`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $fixture '.gitignore'), "monitored/hidden.tmp`n", [Text.UTF8Encoding]::new($false))
    & git -C $fixture add -- .agent-work/tools .agent-work/schemas .agent-work/REPOSITORY_ID .githooks/pre-commit allowed.txt protected.md .gitignore
    & git -C $fixture commit -m 'fixture baseline' | Out-Null
    & git -C $fixture config core.hooksPath .githooks
    $base = (& git -C $fixture rev-parse HEAD).Trim()

    $contract = [ordered]@{
        schema_version=1; contract_id='TASK-X-001'; task_id='TASK-X-001'; owner='CODEX'; supersedes=$null; previous_contract_sha256=$null
        repository=[ordered]@{ repository_id='11111111-1111-4111-8111-111111111111'; expected_root_name=(Split-Path $fixture -Leaf); expected_worktree=($fixture -replace '\\','/'); expected_remote='https://example.invalid/repo.git'; expected_branch='test'; expected_base=$base; allow_detached_head=$false }
        workspace_policy=[ordered]@{ allowed_modified_files=@('allowed.txt','protected.md','forbidden.txt'); allowed_generated_paths=@('.agent-work/tasks/**','.agent-work/evidence/**'); forbidden_modified_files=@('forbidden.txt','.gitignore'); monitored_roots=@('monitored') }
        commit_policy=[ordered]@{ allowed_staged_files=@('allowed.txt'); required_staged_files=@('allowed.txt'); forbidden_staged_files=@('forbidden.txt','.gitignore'); protected_files=@('protected.md'); executor_summary_files=@('allowed.txt'); protected_regions=@([ordered]@{path='protected.md';begin_marker='<!-- BEGIN OWNER:CODEX TEST -->';end_marker='<!-- END OWNER:CODEX TEST -->'}) }
        change_budget=[ordered]@{max_files=1;max_insertions=5;max_deletions=5;max_binary_changes=0;forbid_file_rewrite=$true;preserve_encoding=$true;preserve_line_endings=$true}
        steps=@(
            [ordered]@{id='success';executable='pwsh';arguments=@('-NoProfile','-Command','Write-Output OK; exit 0');cwd='.';timeout_seconds=5;on_nonzero='STOP';requires=@();observation_seconds=0;health_stdout_regex=$null;waiver_id=$null},
            [ordered]@{id='failure';executable='pwsh';arguments=@('-NoProfile','-Command','Write-Error FAIL; exit 7');cwd='.';timeout_seconds=5;on_nonzero='STOP';requires=@('success');observation_seconds=0;health_stdout_regex=$null;waiver_id=$null},
            [ordered]@{id='blocked';executable='pwsh';arguments=@('-NoProfile','-Command','exit 0');cwd='.';timeout_seconds=5;on_nonzero='STOP';requires=@('failure');observation_seconds=0;health_stdout_regex=$null;waiver_id=$null},
            [ordered]@{id='observed';executable='pwsh';arguments=@('-NoProfile','-Command','Write-Output READY; Start-Sleep -Seconds 10');cwd='.';timeout_seconds=15;on_nonzero='STOP';requires=@('success');observation_seconds=1;health_stdout_regex='READY';waiver_id=$null},
            [ordered]@{id='timeout';executable='pwsh';arguments=@('-NoProfile','-Command','Start-Sleep -Seconds 10');cwd='.';timeout_seconds=1;on_nonzero='STOP';requires=@('success');observation_seconds=0;health_stdout_regex=$null;waiver_id=$null}
        )
        evidence=[ordered]@{root='.agent-work/evidence';environment_allowlist=@('TEMP')}
        forbidden_phrases=@('可以安全合并');waivers=@()
    }
    $contractPath = Join-Path $fixture '.agent-work\tasks\TASK-X-001.json'
    [IO.File]::WriteAllText($contractPath, (($contract | ConvertTo-Json -Depth 100) + "`n"), [Text.UTF8Encoding]::new($false))
    . (Join-Path $fixture '.agent-work\tools\Common.ps1')
    $contractHash = Get-NormalizedTextSha256 $contractPath

    $runner = Join-Path $fixture '.agent-work\tools\ANTIGRAVITY_TASK_RUNNER.ps1'
    $run = Invoke-Child $runner @('-ContractPath',$contractPath)
    if ($run.ExitCode -ne 0) { throw "Runner fixture failed ($($run.ExitCode)):`n$($run.Output)" }
    $summaryPath = ($run.Output -split "`n" | Select-Object -Last 1).Trim()
    if (-not (Test-Path -LiteralPath $summaryPath)) { throw "Runner summary path is missing: $summaryPath`nRunner output:`n$($run.Output)" }
    $summary = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json -Depth 100
    $states = @{}; foreach($s in $summary.steps){$states[[string]$s.step_id]=[string]$s.result}
    $runnerPass = $run.ExitCode -eq 0 -and $states.success -eq 'SUCCEEDED' -and $states.failure -eq 'FAILED' -and $states.blocked -eq 'BLOCKED_BY_PREVIOUS_STEP' -and $states.observed -eq 'OBSERVED_THEN_TERMINATED' -and $states.timeout -eq 'TIMED_OUT'
    Add-Result 'runner-result-model' $runnerPass (($states | ConvertTo-Json -Compress))
    $preflightPath = Join-Path (Split-Path $summaryPath -Parent) 'preflight.json'

    [IO.File]::WriteAllText((Join-Path $fixture 'allowed.txt'), "changed`n", [Text.UTF8Encoding]::new($false)); & git -C $fixture add -- allowed.txt
    $checker = Join-Path $fixture '.agent-work\tools\PRECOMMIT_SCOPE_CHECK.ps1'
    $valid = Invoke-Child $checker @('-ContractPath',$contractPath,'-ExpectedContractSha256',$contractHash,'-PreflightManifest',$preflightPath)
    Add-Result 'valid-scope' ($valid.ExitCode -eq 0) $valid.Output

    $savedContract = [IO.File]::ReadAllBytes($contractPath); [IO.File]::AppendAllText($contractPath, " `n")
    $tamper = Invoke-Child $checker @('-ContractPath',$contractPath,'-ExpectedContractSha256',$contractHash)
    Add-Result 'contract-tamper' ($tamper.ExitCode -eq 10) $tamper.Output
    [IO.File]::WriteAllBytes($contractPath,$savedContract)

    $lfContract = Get-Content -LiteralPath $contractPath -Raw -Encoding utf8
    [IO.File]::WriteAllText($contractPath, ($lfContract -replace "(?<!`r)`n", "`r`n"), [Text.UTF8Encoding]::new($false))
    $lineEndingStable = Invoke-Child $checker @('-ContractPath',$contractPath,'-ExpectedContractSha256',$contractHash)
    Add-Result 'contract-line-ending-stability' ($lineEndingStable.ExitCode -eq 0) $lineEndingStable.Output
    [IO.File]::WriteAllBytes($contractPath,$savedContract)

    [IO.File]::WriteAllText((Join-Path $fixture 'forbidden.txt'), "forbidden`n", [Text.UTF8Encoding]::new($false))
    $forbidden = Invoke-Child $checker @('-ContractPath',$contractPath,'-ExpectedContractSha256',$contractHash)
    Add-Result 'forbidden-file' ($forbidden.ExitCode -eq 11) $forbidden.Output
    Remove-Item -LiteralPath (Join-Path $fixture 'forbidden.txt')

    [IO.File]::WriteAllText((Join-Path $fixture 'protected.md'), "<!-- BEGIN OWNER:CODEX TEST -->`nchanged`n<!-- END OWNER:CODEX TEST -->`n", [Text.UTF8Encoding]::new($false))
    $protected = Invoke-Child $checker @('-ContractPath',$contractPath,'-ExpectedContractSha256',$contractHash)
    Add-Result 'protected-region' ($protected.ExitCode -eq 12) $protected.Output
    & git -C $fixture restore --worktree -- protected.md

    New-Item -ItemType Directory -Force -Path (Join-Path $fixture 'monitored') | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture 'monitored\hidden.tmp'), 'hidden', [Text.UTF8Encoding]::new($false))
    $ignored = Invoke-Child $checker @('-ContractPath',$contractPath,'-ExpectedContractSha256',$contractHash)
    Add-Result 'ignored-hidden-file' ($ignored.ExitCode -eq 19) $ignored.Output
    Remove-Item -LiteralPath (Join-Path $fixture 'monitored\hidden.tmp'); Remove-Item -LiteralPath (Join-Path $fixture 'monitored')

    [IO.File]::WriteAllText((Join-Path $fixture 'allowed.txt'), ([char]0xFEFF) + "changed`n", [Text.UTF8Encoding]::new($false)); & git -C $fixture add -- allowed.txt
    $encoding = Invoke-Child $checker @('-ContractPath',$contractPath,'-ExpectedContractSha256',$contractHash,'-PreflightManifest',$preflightPath)
    Add-Result 'encoding-change' ($encoding.ExitCode -eq 18) $encoding.Output
    [IO.File]::WriteAllText((Join-Path $fixture 'allowed.txt'), "changed`n", [Text.UTF8Encoding]::new($false)); & git -C $fixture add -- allowed.txt

    $rawSessionRoot = Split-Path (Split-Path $summaryPath -Parent) -Parent -Resolve
    $rawTaskRoot = Join-Path $fixture '.agent-work\evidence\raw\TASK-X-001'
    $manifestPath = Join-Path (Split-Path $summaryPath -Parent) 'evidence-index.json'
    $manifestTool = Join-Path $fixture '.agent-work\tools\EVIDENCE_MANIFEST.ps1'
    $manifestRun = Invoke-Child $manifestTool @('-ContractPath',$contractPath,'-TaskEvidenceRoot',$rawTaskRoot,'-OutputPath',([IO.Path]::GetRelativePath($fixture,$manifestPath)))
    $rawFile = Get-ChildItem -LiteralPath $rawTaskRoot -File -Recurse | Select-Object -First 1
    [IO.File]::AppendAllText($rawFile.FullName,'tamper')
    $rawTamper = Invoke-Child $checker @('-ContractPath',$contractPath,'-ExpectedContractSha256',$contractHash,'-EvidenceManifest',$manifestPath)
    Add-Result 'raw-evidence-tamper' ($rawTamper.ExitCode -eq 14) $rawTamper.Output
    [IO.File]::WriteAllText($rawFile.FullName, '', [Text.UTF8Encoding]::new($false))

    & git -C $fixture restore --staged -- allowed.txt
    [IO.File]::WriteAllText((Join-Path $fixture 'allowed.txt'), "safe commit`n", [Text.UTF8Encoding]::new($false))
    $safe = Join-Path $fixture '.agent-work\tools\SAFE_COMMIT.ps1'
    $safeRun = Invoke-Child $safe @('-ContractPath',$contractPath,'-Message','safe fixture commit')
    $verify = Join-Path $fixture '.agent-work\tools\VERIFY_ATTESTATION.ps1'
    $verifyRun = Invoke-Child $verify @('-ContractPath',$contractPath,'-Commit','HEAD')
    Add-Result 'safe-commit-attestation' ($safeRun.ExitCode -eq 0 -and $verifyRun.ExitCode -eq 0) ($safeRun.Output + "`n" + $verifyRun.Output)
    $commonDir = (& git -C $fixture rev-parse --git-common-dir).Trim()
    if (-not [IO.Path]::IsPathRooted($commonDir)) { $commonDir = Join-Path $fixture $commonDir }
    $safeCommit = (& git -C $fixture rev-parse HEAD).Trim()
    $commonReceipt = Join-Path (Join-Path $commonDir 'codex-attestations') ("$safeCommit.json")
    Add-Result 'common-git-dir-receipt' (Test-Path -LiteralPath $commonReceipt) $commonReceipt

    [IO.File]::WriteAllText((Join-Path $fixture 'allowed.txt'), "direct`n", [Text.UTF8Encoding]::new($false)); & git -C $fixture add -- allowed.txt
    $directOutput = & git -C $fixture commit -m 'direct commit' 2>&1; $directExit = $LASTEXITCODE
    $directText = $directOutput -join "`n"
    Add-Result 'direct-commit-hook-rejection' ($directExit -ne 0 -and $directText -match 'SAFE_COMMIT_REQUIRED') $directText
    & git -C $fixture restore --staged -- allowed.txt
    [IO.File]::WriteAllText((Join-Path $fixture 'allowed.txt'), "bypass`n", [Text.UTF8Encoding]::new($false)); & git -C $fixture add -- allowed.txt; & git -C $fixture commit --no-verify -m 'bypass' | Out-Null
    $bypass = Invoke-Child $verify @('-ContractPath',$contractPath,'-Commit','HEAD')
    Add-Result 'no-verify-lacks-attestation' ($bypass.ExitCode -ne 0) $bypass.Output

    $report = [ordered]@{ schema_version=1; generated_at_utc=[DateTime]::UtcNow.ToString('o'); fixture=$fixture; passed=(@($results | Where-Object passed).Count); failed=(@($results | Where-Object { -not $_.passed }).Count); results=$results }
    $destination = Join-Path $sourceRoot ($OutputPath -replace '/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
    [IO.File]::WriteAllText($destination, (($report | ConvertTo-Json -Depth 100) + "`n"), [Text.UTF8Encoding]::new($false))
    if ($report.failed -gt 0) { throw "$($report.failed) governance red-team tests failed. See $destination" }
    Write-Output $destination
} finally {
    $resolvedFixture = [IO.Path]::GetFullPath($fixture)
    if ($resolvedFixture.StartsWith($tempBase + '\',[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolvedFixture -Leaf).StartsWith('watchtracker-governance-redteam-')) {
        if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
    }
}
