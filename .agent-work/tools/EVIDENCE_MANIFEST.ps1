param(
    [Parameter(Mandatory)][string]$ContractPath,
    [Parameter(Mandatory)][string[]]$TaskEvidenceRoot,
    [Parameter(Mandatory)][string]$OutputPath
)

. (Join-Path $PSScriptRoot 'Common.ps1')
$contractInfo = Read-TaskContract $ContractPath
$root = Assert-RepositoryIdentity $contractInfo
$outputFull = [IO.Path]::GetFullPath((Join-Path $root $OutputPath))
$items = @()
foreach ($evidenceRootInput in $TaskEvidenceRoot) {
    $evidenceRoot = (Resolve-Path -LiteralPath $evidenceRootInput).Path
    Get-ChildItem -LiteralPath $evidenceRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
        if ([IO.Path]::GetFullPath($_.FullName) -cne $outputFull) {
            $relative = ConvertTo-NormalPath ([IO.Path]::GetRelativePath($root, $_.FullName))
            if (-not @($items | Where-Object { $_.path -ceq $relative }).Count) {
                $items += [ordered]@{
                    path = $relative
                    size = $_.Length
                    sha256 = Get-Sha256 $_.FullName
                    creation_time_utc = $_.CreationTimeUtc.ToString('o')
                    last_write_time_utc = $_.LastWriteTimeUtc.ToString('o')
                }
            }
        }
    }
}
$manifest = [ordered]@{
    schema_version = 1
    task_id = $contractInfo.Value.task_id
    contract_path = ConvertTo-NormalPath ([IO.Path]::GetRelativePath($root, $contractInfo.Path))
    contract_sha256 = $contractInfo.Sha256
    generated_at_utc = [DateTime]::UtcNow.ToString('o')
    files = $items
}
Write-JsonUtf8 $manifest $outputFull
Write-Output $outputFull
