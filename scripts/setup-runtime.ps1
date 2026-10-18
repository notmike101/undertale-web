$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$runtimeDir = Join-Path $repoRoot 'web/runtime'
$privateDir = Join-Path $repoRoot '.private'
$hashes = @{
    'butterscotch.mjs' = 'FAD2F26692C9B61FED73090E4F378AFCADE8A09103FEFCB4B079EAF989ACE966'
    'butterscotch.wasm' = 'B202189311012D24D5CBAF2F941FF40373A3CBAAD03A969BFE81C23E93AAF5D2'
    'butterscotch-source.zip' = '0AFA091A94EC3115D0BB27CCEF7445FACEBF2EBAC7E773D967D3A9603B4519B8'
}
foreach ($name in $hashes.Keys) {
    $path = Join-Path $runtimeDir $name
    if (!(Test-Path -LiteralPath $path) -or (Get-FileHash -LiteralPath $path).Hash -ne $hashes[$name]) {
        throw "Missing or changed runtime artifact: $path. Restore the checked-in file before setup."
    }
}
New-Item -ItemType Directory -Force $privateDir | Out-Null
if (!(Test-Path -LiteralPath (Join-Path $privateDir 'Butterscotch'))) {
    Expand-Archive -LiteralPath (Join-Path $runtimeDir 'butterscotch-source.zip') -DestinationPath $privateDir
}
Write-Host 'Verified patched runtime and prepared corresponding source in .private/Butterscotch.'
