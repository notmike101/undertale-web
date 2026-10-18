$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$privateDir = Join-Path $repoRoot '.private'
$runtimeDir = Join-Path $repoRoot 'web/runtime'
$revision = 'f6f1d30a2f933e5e0e77941251c7bd38e361a2ce'
New-Item -ItemType Directory -Force $privateDir, $runtimeDir | Out-Null

function Get-VerifiedDownload($Url, $Path, $Sha256) {
    if (!(Test-Path -LiteralPath $Path) -or (Get-FileHash -LiteralPath $Path).Hash -ne $Sha256) {
        Invoke-WebRequest -Uri $Url -OutFile $Path
    }
    if ((Get-FileHash -LiteralPath $Path).Hash -ne $Sha256) {
        throw "SHA-256 mismatch: $Path"
    }
}

$archivePath = Join-Path $privateDir 'butterscotch-web-pinned.zip'
Get-VerifiedDownload 'https://nightly.link/ButterscotchRunner/Butterscotch/actions/runs/38919991284/butterscotch-web.zip' $archivePath '8AC4B5999FA4182AA5B70708BCBE1FF569CD6E43822970589CE466BDEFB6C9DF'
Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeDir -Force

$sourceArchive = Join-Path $runtimeDir 'butterscotch-source.zip'
Get-VerifiedDownload "https://codeload.github.com/ButterscotchRunner/Butterscotch/zip/$revision" $sourceArchive 'C2836FE2376D96B89CBEA58404D08FB2509D3CF32EC2665848B0A891B91390E5'
$sourceDir = Join-Path $privateDir "Butterscotch-$revision"
if (!(Test-Path -LiteralPath $sourceDir)) {
    Expand-Archive -LiteralPath $sourceArchive -DestinationPath $privateDir
}
Copy-Item -LiteralPath (Join-Path $sourceDir 'LICENSE') -Destination (Join-Path $runtimeDir 'LICENSE')
Write-Host "Installed verified Butterscotch runtime $revision"
