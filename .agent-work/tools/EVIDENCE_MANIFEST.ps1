param(
    [Parameter(Mandatory)][string]$ContractPath,
    [Parameter(Mandatory)][string]$ExpectedContractBytesSha256,
    [Parameter(Mandatory)][string]$ExpectedTaskId,
    [Parameter(Mandatory)][string]$TaskEvidenceRoot,
    [Parameter(Mandatory)][string]$OutputPath
)
. (Join-Path $PSScriptRoot 'Common.ps1')
$governanceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'));$info=Read-TaskContractSnapshot $ContractPath $ExpectedContractBytesSha256 $ExpectedTaskId $governanceRoot;$root=Assert-RepositoryIdentity $info;$output=[IO.Path]::GetFullPath((Join-Path $root $OutputPath));$items=@()
foreach($inputRoot in @($TaskEvidenceRoot-split';'|Where-Object{$_})){$evidenceRoot=(Resolve-Path -LiteralPath $inputRoot).Path;Get-ChildItem -LiteralPath $evidenceRoot -File -Recurse|Sort-Object FullName|ForEach-Object{if([IO.Path]::GetFullPath($_.FullName)-ceq$output){return};$relative=ConvertTo-NormalPath([IO.Path]::GetRelativePath($root,$_.FullName));if(@($items|Where-Object{$_.path-ceq$relative}).Count){return};$producerEnd=$null;if($_.Extension-eq'.json'){try{$json=Get-Content -LiteralPath $_.FullName -Raw|ConvertFrom-Json -Depth 100;if($json.ended_at_utc){$producerEnd=[string]$json.ended_at_utc}elseif($json.session_ended_at_utc){$producerEnd=[string]$json.session_ended_at_utc}}catch{}};$hashedAt=[DateTime]::UtcNow.ToString('o');$items+=[ordered]@{path=$relative;size=$_.Length;sha256=Get-Sha256 $_.FullName;creation_time_utc=$_.CreationTimeUtc.ToString('o');last_write_time_utc=$_.LastWriteTimeUtc.ToString('o');producer_ended_at_utc=$producerEnd;hashed_at_utc=$hashedAt}}}
$manifest=[ordered]@{schema_version=2;task_id=$ExpectedTaskId;contract_path=ConvertTo-NormalPath $info.Path;contract_bytes_sha256=$info.BytesSha256;contract_normalized_sha256=$info.NormalizedSha256;generated_at_utc=[DateTime]::UtcNow.ToString('o');capture_policy='REDACT_AT_INGRESS';files=$items};Write-JsonUtf8Atomic $manifest $output;Write-Output $output
