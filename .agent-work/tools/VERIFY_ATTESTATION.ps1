param(
    [Parameter(Mandatory)][string]$ContractPath,
    [string]$Commit = 'HEAD'
)

. (Join-Path $PSScriptRoot 'Common.ps1')
$contractInfo = Read-TaskContract $ContractPath
$root = ConvertTo-NormalPath (Invoke-GitText @('rev-parse','--show-toplevel'))
$resolvedCommit = Invoke-GitText @('rev-parse',$Commit) $root
$message = Invoke-GitText @('show','-s','--format=%B',$resolvedCommit) $root
if ($message -notmatch "(?m)^Contract-SHA256:\s*([A-Fa-f0-9]{64})\s*$") { throw 'Commit lacks Contract-SHA256 trailer.' }
if ($Matches[1].ToUpperInvariant() -cne $contractInfo.Sha256) { throw 'Commit contract trailer does not match contract.' }
if ($message -notmatch '(?m)^Safe-Commit-Version:\s*1\s*$') { throw 'Commit lacks supported Safe-Commit-Version trailer.' }
if ($message -notmatch '(?m)^Scope-Check:\s*PASS\s*$') { throw 'Commit lacks Scope-Check PASS trailer.' }
$gitPath = Invoke-GitText @('rev-parse','--git-path','codex-attestations') $root
if (-not [IO.Path]::IsPathRooted($gitPath)) { $gitPath = Join-Path $root $gitPath }
$receiptPath = Join-Path $gitPath ("$resolvedCommit.json")
if (-not (Test-Path -LiteralPath $receiptPath)) { throw 'Safe Commit receipt is missing.' }
$receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json -Depth 100
if ([string]$receipt.commit -cne $resolvedCommit -or [string]$receipt.contract_sha256 -cne $contractInfo.Sha256 -or [int]$receipt.scope_check_exit -ne 0) { throw 'Safe Commit receipt is inconsistent.' }
$actualText = Invoke-GitText @('diff-tree','--no-commit-id','--name-only','-r',$resolvedCommit) $root
$actual = if ($actualText) { @($actualText -split "`n" | Sort-Object) } else { @() }
if (($actual -join "`n") -cne (@($receipt.staged_files | Sort-Object) -join "`n")) { throw 'Receipt file set does not match commit.' }
Write-Output ([ordered]@{ result='PASS'; commit=$resolvedCommit; contract_sha256=$contractInfo.Sha256; receipt=$receiptPath } | ConvertTo-Json)
