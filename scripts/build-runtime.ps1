param(
    [string]$SourceDirectory = '',
    [string]$EmsdkDirectory = ''
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
if (!$SourceDirectory) {
    $SourceDirectory = Join-Path $repoRoot '.private/Butterscotch'
}
if (!$EmsdkDirectory) { $EmsdkDirectory = Join-Path $repoRoot '.private/emsdk' }
if (!(Test-Path -LiteralPath (Join-Path $SourceDirectory 'CMakeLists.txt'))) {
    throw 'Source is missing. Run scripts/setup-runtime.ps1 first.'
}
if (!(Test-Path -LiteralPath (Join-Path $EmsdkDirectory 'emsdk_env.ps1'))) {
    throw 'Install and activate Emscripten 6.0.12 in .private/emsdk, or pass -EmsdkDirectory.'
}
$env:EMSDK_QUIET = '1'
. (Join-Path $EmsdkDirectory 'emsdk_env.ps1')
$localTools = Join-Path $repoRoot '.private/build-tools'
if (Test-Path -LiteralPath $localTools) {
    $env:PATH = "$(Join-Path $localTools 'cmake/data/bin');$(Join-Path $localTools 'bin');$env:PATH"
}
$buildDirectory = Join-Path $repoRoot '.private/runtime-build'
& emcmake cmake -S $SourceDirectory -B $buildDirectory -G Ninja -DPLATFORM=web -DBACKEND=web -DCMAKE_BUILD_TYPE=Release -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=ON
if ($LASTEXITCODE -ne 0) { throw 'Runtime configure failed.' }
& cmake --build $buildDirectory --parallel 8
if ($LASTEXITCODE -ne 0) { throw 'Runtime build failed.' }
Write-Host "Built $buildDirectory/butterscotch.mjs and butterscotch.wasm. The shipped runtime was not changed."
