Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-GitText {
    param([Parameter(Mandatory)][string[]]$Arguments, [string]$WorkingDirectory = (Get-Location).Path)
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = 'git'
    [void]$psi.ArgumentList.Add('-C'); [void]$psi.ArgumentList.Add($WorkingDirectory)
    foreach ($argument in $Arguments) { [void]$psi.ArgumentList.Add($argument) }
    $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($psi)
    $stdoutTask = $process.StandardOutput.ReadToEndAsync(); $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult(); $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw "git $($Arguments -join ' ') failed ($($process.ExitCode)): $stderr" }
    return $stdout.TrimEnd("`r","`n")
}

function Get-Sha256 {
    param([Parameter(Mandatory)][string]$LiteralPath)
    return (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Get-NormalizedTextSha256 {
    param([Parameter(Mandatory)][string]$LiteralPath)
    $text = Get-Content -LiteralPath $LiteralPath -Raw -Encoding utf8
    $normalized = ($text -replace "`r`n", "`n")
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($normalized)
    $hash = [Security.Cryptography.SHA256]::HashData($bytes)
    return ([Convert]::ToHexString($hash)).ToUpperInvariant()
}

function ConvertTo-NormalPath {
    param([AllowEmptyString()][AllowNull()][string]$Path)
    if ([string]::IsNullOrEmpty($Path)) { return '' }
    return ($Path -replace '\\', '/').TrimEnd('/')
}

function Convert-GlobToRegex {
    param([Parameter(Mandatory)][string]$Pattern)
    $normalized = ConvertTo-NormalPath $Pattern
    $escaped = [Regex]::Escape($normalized)
    $escaped = $escaped -replace '\\\*\\\*', '.*'
    $escaped = $escaped -replace '\\\*', '[^/]*'
    $escaped = $escaped -replace '\\\?', '[^/]'
    return '^' + $escaped + '$'
}

function Test-PathMatchesAny {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Patterns)
    $normalized = ConvertTo-NormalPath $Path
    foreach ($pattern in @($Patterns)) {
        if ($normalized -match (Convert-GlobToRegex ([string]$pattern))) { return $true }
    }
    return $false
}

function Read-TaskContract {
    param([Parameter(Mandatory)][string]$ContractPath)
    $resolved = (Resolve-Path -LiteralPath $ContractPath).Path
    $schema = Join-Path (Split-Path (Split-Path $resolved -Parent) -Parent) 'schemas\task-contract.schema.json'
    if (-not (Test-Path -LiteralPath $schema)) { throw "Task contract schema is missing: $schema" }
    $raw = Get-Content -LiteralPath $resolved -Raw -Encoding utf8
    if (-not ($raw | Test-Json -SchemaFile $schema -ErrorAction Stop)) { throw 'Task contract schema validation failed.' }
    return [pscustomobject]@{
        Path = $resolved
        Sha256 = Get-NormalizedTextSha256 $resolved
        Value = $raw | ConvertFrom-Json -Depth 100
    }
}

function Assert-RepositoryIdentity {
    param([Parameter(Mandatory)]$ContractInfo)
    $contract = $ContractInfo.Value
    $root = ConvertTo-NormalPath (Invoke-GitText @('rev-parse', '--show-toplevel'))
    $expectedRoot = ConvertTo-NormalPath ([string]$contract.repository.expected_worktree)
    if ($root -cne $expectedRoot) { throw "Wrong worktree. Expected $expectedRoot; actual $root" }
    if ((Split-Path $root -Leaf) -cne [string]$contract.repository.expected_root_name) { throw 'Wrong worktree root name.' }
    $repoIdPath = Join-Path $root '.agent-work\REPOSITORY_ID'
    if (-not (Test-Path -LiteralPath $repoIdPath)) { throw 'REPOSITORY_ID is missing.' }
    $repoId = (Get-Content -LiteralPath $repoIdPath -Raw).Trim()
    if ($repoId -cne [string]$contract.repository.repository_id) { throw 'Repository ID mismatch.' }
    $branch = Invoke-GitText @('branch', '--show-current')
    if (-not $contract.repository.allow_detached_head -and [string]::IsNullOrWhiteSpace($branch)) { throw 'Detached HEAD is forbidden.' }
    if ($branch -cne [string]$contract.repository.expected_branch) { throw "Wrong branch: $branch" }
    $head = Invoke-GitText @('rev-parse', 'HEAD')
    if ($head -cne [string]$contract.repository.expected_base) { throw "HEAD does not match contract BASE. Expected $($contract.repository.expected_base); actual $head" }
    $remote = Invoke-GitText @('remote', 'get-url', 'origin')
    $remote = $remote -replace '://[^/@]+@', '://'
    if ($remote -cne [string]$contract.repository.expected_remote) { throw "Remote mismatch: $remote" }
    return $root
}

function Get-WorkspaceChangePaths {
    param([string]$Root = (Get-Location).Path)
    $paths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($args in @(@('diff','--name-only'), @('diff','--cached','--name-only'), @('ls-files','--others','--exclude-standard'))) {
        $text = Invoke-GitText -Arguments $args -WorkingDirectory $Root
        foreach ($line in ($text -split "`n")) {
            if (-not [string]::IsNullOrWhiteSpace($line)) { [void]$paths.Add((ConvertTo-NormalPath $line.Trim())) }
        }
    }
    return @($paths | Sort-Object)
}

function Get-StagedPaths {
    param([string]$Root = (Get-Location).Path)
    $text = Invoke-GitText @('diff','--cached','--name-only') $Root
    if ([string]::IsNullOrWhiteSpace($text)) { return @() }
    return @($text -split "`n" | ForEach-Object { ConvertTo-NormalPath $_.Trim() } | Where-Object { $_ })
}

function Get-FileFingerprint {
    param([Parameter(Mandatory)][string]$LiteralPath)
    $bytes = [IO.File]::ReadAllBytes($LiteralPath)
    $bom = if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { 'UTF8-BOM' } else { 'NONE' }
    $text = [Text.Encoding]::UTF8.GetString($bytes)
    $crlf = ([regex]::Matches($text, "`r`n")).Count
    $lf = ([regex]::Matches($text, "(?<!`r)`n")).Count
    $lineEnding = if ($crlf -gt 0 -and $lf -eq 0) { 'CRLF' } elseif ($lf -gt 0 -and $crlf -eq 0) { 'LF' } elseif ($lf -eq 0 -and $crlf -eq 0) { 'NONE' } else { 'MIXED' }
    return [ordered]@{ sha256 = Get-Sha256 $LiteralPath; size = $bytes.Length; bom = $bom; line_endings = $lineEnding }
}

function Get-ProtectedRegionText {
    param([Parameter(Mandatory)][string]$Text, [Parameter(Mandatory)][string]$Begin, [Parameter(Mandatory)][string]$End)
    $beginCount = ([regex]::Matches($Text, [regex]::Escape($Begin))).Count
    $endCount = ([regex]::Matches($Text, [regex]::Escape($End))).Count
    if ($beginCount -ne 1 -or $endCount -ne 1) { throw "Protected markers must occur exactly once: $Begin / $End" }
    $start = $Text.IndexOf($Begin, [StringComparison]::Ordinal)
    $finish = $Text.IndexOf($End, $start + $Begin.Length, [StringComparison]::Ordinal)
    if ($finish -lt $start) { throw 'Protected region markers are out of order.' }
    return ($Text.Substring($start, ($finish + $End.Length) - $start) -replace "`r`n", "`n")
}

function Write-JsonUtf8 {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string]$LiteralPath, [int]$Depth = 100)
    $parent = Split-Path $LiteralPath -Parent
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $json = $Value | ConvertTo-Json -Depth $Depth
    [IO.File]::WriteAllText($LiteralPath, $json + "`n", [Text.UTF8Encoding]::new($false))
}
