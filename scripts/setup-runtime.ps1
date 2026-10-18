$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$runtimeDir = Join-Path $repoRoot 'web/runtime'
$privateDir = Join-Path $repoRoot '.private'
$hashes = @{
    'butterscotch.mjs' = '92154A624B0086EB97C5CBAAF94CA0DFE078CE0587F170B9CB3D79491692283B'
    'butterscotch.wasm' = '41A3297BAA56F41C544C25B8DD8DE5FA11C07CD2BA8FCB5E6FB2C6C53CDF4402'
    'butterscotch-source.zip' = '1D78A595E3AD72B8362D6077748807593E979A79CCDCC05466B8BEEE28E9F1E3'
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
